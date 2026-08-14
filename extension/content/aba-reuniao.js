/**
 * A aba "Reunião" — uma coluna lateral dentro do chatPro, no mesmo lugar e com
 * o mesmo comportamento do Copiloto.
 *
 * A DIFERENÇA QUE MANDA NA TÉCNICA: ela ENTRA no layout, não fica por cima.
 * O Copiloto é um irmão de flex da área de conversa — quando abre, a conversa
 * encolhe e continua inteira, só mais estreita. Um painel `position: fixed`
 * pareceria igual numa tela grande e taparia a conversa numa pequena, que é
 * exatamente quando o atendente mais precisa ler os dois lados.
 *
 * COMO ACHAMOS ONDE ENTRAR, sem depender das classes do chatPro (que são
 * geradas e mudam a cada deploy):
 *
 *   1. Se o Copiloto estiver aberto, o pai DELE é o nosso pai. Caminho exato.
 *   2. Senão, procuramos o container por FORMA: o flex-row mais externo que
 *      ocupa a tela e tem a área de conversa dentro. Entramos como último filho.
 *   3. Sem nada disso (layout mudou de vez), caímos numa gaveta sobreposta —
 *      pior, mas o atendente ainda marca a reunião.
 *
 * TELA ESTREITA: abaixo de 1100 px não há o que encolher sem espremer a
 * conversa a nada, então a aba vira gaveta sobreposta de propósito — é o que o
 * próprio chatPro faz com os painéis dele.
 *
 * REACT: o container é gerenciado por React, que remove nós que não conhece ao
 * re-renderizar. Um observer recoloca a aba se ela sumir sem a gente ter
 * fechado.
 */

(() => {
  'use strict';

  const ID = 'cpm-aba-reuniao';
  const LARGURA = 380;
  const LARGURA_MIN = 320;
  /** Abaixo disso, empurrar espremeria a conversa: melhor sobrepor. */
  const LIMIAR_ESTREITO = 1100;
  /** Mesma curva e duração que um painel lateral do chatPro usa. */
  const TRANSICAO = '220ms cubic-bezier(.4,0,.2,1)';

  // ─── Identidade visual ─────────────────────────────────────────────────────

  function escuro() {
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    if (!m) return document.documentElement.classList.contains('dark');
    // Luminância perceptual: o fundo escuro do chatPro fica bem abaixo de 128.
    return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3] < 128;
  }

  /**
   * Estilo MEDIDO no Copiloto, quando ele está aberto.
   *
   * Chutar as cores de um print faz a aba ficar "parecida" e envelhecer mal:
   * qualquer ajuste de tema do chatPro nos deixaria pra trás. Medir os valores
   * reais faz a aba acompanhar sozinha — e é o mesmo truque que o botão da
   * barra já usa, clonando o vizinho em vez de recriar o CSS deles.
   *
   * O resultado fica no chrome.storage porque o Copiloto normalmente está
   * FECHADO na hora em que a nossa aba abre: sem guardar, a medição só valeria
   * na única vez em que os dois estivessem abertos juntos.
   */
  const CHAVE_ESTILO = 'cpm_estilo_copiloto';
  let estiloMedido = null;

  function corDe(valor, alternativa) {
    if (!valor) return alternativa;
    const v = String(valor).trim();
    if (v === '' || v === 'none' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(v) || v === 'transparent') {
      return alternativa;
    }
    return v;
  }

  /** Lê do Copiloto aberto o que dá pra copiar sem adivinhar. */
  function medirCopiloto(painel) {
    try {
      const s = getComputedStyle(painel);
      const medida = { fundo: corDe(s.backgroundColor, null) };

      // O cabeçalho é o primeiro filho alto o bastante pra ser barra e baixo o
      // bastante pra não ser conteúdo.
      for (const filho of painel.children) {
        const r = filho.getBoundingClientRect();
        if (r.height >= 36 && r.height <= 96) {
          const cs = getComputedStyle(filho);
          medida.alturaCabecalho = Math.round(r.height);
          medida.fundoCabecalho = corDe(cs.backgroundColor, null);
          medida.bordaCabecalho = cs.borderBottomWidth !== '0px' ? cs.borderBottomColor : null;
          break;
        }
      }

      // Título: o texto mais destacado dentro do cabeçalho.
      const titulo = painel.querySelector('h1,h2,h3,[class*="title"],[class*="titulo"]');
      if (titulo) {
        const ts = getComputedStyle(titulo);
        medida.tituloTamanho = ts.fontSize;
        medida.tituloPeso = ts.fontWeight;
        medida.tituloCor = corDe(ts.color, null);
      }

      // Campos: o raio e o fundo deles são o que mais denuncia diferença.
      const campo = painel.querySelector('input,textarea,select');
      if (campo) {
        const cs = getComputedStyle(campo);
        medida.campoFundo = corDe(cs.backgroundColor, null);
        medida.campoBorda = cs.borderTopWidth !== '0px' ? cs.borderTopColor : null;
        medida.campoRaio = cs.borderRadius;
        medida.campoPadding = cs.padding;
        medida.campoFonte = cs.fontSize;
      }

      // Botão primário: o de maior largura dentro do painel.
      let maior = null;
      for (const b of painel.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width > 120 && (!maior || r.width > maior.r.width)) maior = { b, r };
      }
      if (maior) {
        const bs = getComputedStyle(maior.b);
        medida.botaoFundo = corDe(bs.backgroundColor, null);
        medida.botaoCor = corDe(bs.color, null);
        medida.botaoRaio = bs.borderRadius;
        medida.botaoAltura = `${Math.round(maior.r.height)}px`;
        medida.botaoPeso = bs.fontWeight;
      }

      medida.fonte = s.fontFamily;
      return medida;
    } catch {
      return null;
    }
  }

  /** Guarda a medição pra valer quando o Copiloto estiver fechado. */
  function guardarEstilo(medida) {
    estiloMedido = medida;
    try {
      chrome.storage?.local?.set({ [CHAVE_ESTILO]: medida });
    } catch {
      // storage indisponível não pode derrubar a abertura da aba.
    }
  }

  function carregarEstilo() {
    try {
      chrome.storage?.local?.get(CHAVE_ESTILO, (r) => {
        if (r && r[CHAVE_ESTILO] && !estiloMedido) estiloMedido = r[CHAVE_ESTILO];
      });
    } catch {
      /* idem */
    }
  }
  carregarEstilo();

  /**
   * Tokens da identidade chatPro, com o que foi medido no Copiloto por cima.
   *
   * Os padrões são os valores oficiais (#25D066 CTA, #1BAD53 hover, cinzas
   * #1d2125 / #22272b / #2c333a) — usados quando ninguém abriu o Copiloto
   * ainda. A medição real ganha deles sempre que existe.
   */
  function paleta() {
    const e = escuro();
    const m = estiloMedido || {};
    return {
      escuro: e,
      fundo: m.fundo || (e ? '#22272b' : '#ffffff'),
      fundoFraco: e ? '#2c333a' : '#f1f0f2',
      fundoTopo: m.fundoCabecalho || m.fundo || (e ? '#22272b' : '#ffffff'),
      texto: m.tituloCor || (e ? '#E6E5E8' : '#1d2125'),
      textoFraco: e ? '#9aa4ad' : '#6b7280',
      borda: m.bordaCabecalho || (e ? 'rgba(255,255,255,.10)' : '#E6E5E8'),
      verde: m.botaoFundo || '#25D066',
      verdeHover: m.botaoFundo ? m.botaoFundo : '#1BAD53',
      botaoCor: m.botaoCor || (m.botaoFundo ? '#ffffff' : '#0b2016'),
      botaoRaio: m.botaoRaio || '8px',
      botaoAltura: m.botaoAltura || '48px',
      botaoPeso: m.botaoPeso || '600',
      perigo: e ? '#ff6b6b' : '#c92a2a',
      // Cabeçalho e campos, medidos ou no padrão do print do Copiloto.
      alturaCabecalho: m.alturaCabecalho ? `${m.alturaCabecalho}px` : '60px',
      tituloTamanho: m.tituloTamanho || '17px',
      tituloPeso: m.tituloPeso || '600',
      campoFundo: m.campoFundo || (e ? '#1d2125' : '#ffffff'),
      campoBorda: m.campoBorda || (e ? 'rgba(255,255,255,.12)' : '#D1D1D5'),
      campoRaio: m.campoRaio || '8px',
      campoPadding: m.campoPadding || '13px 14px',
      campoFonte: m.campoFonte || '14px',
      fonte: m.fonte || 'system-ui,-apple-system,Segoe UI,sans-serif',
    };
  }

  // ─── Onde a aba entra ──────────────────────────────────────────────────────

  function ehFlexRow(el) {
    const s = getComputedStyle(el);
    if (s.display !== 'flex' && s.display !== 'grid') return false;
    return s.display === 'grid' || s.flexDirection === 'row';
  }

  /**
   * O painel do Copiloto, quando aberto: bloco alto encostado na direita, com
   * largura de painel. Achando ele, o pai dele é onde a gente entra — é a
   * garantia de cair no mesmo nível do layout.
   */
  function acharCopiloto() {
    const alturaMin = window.innerHeight * 0.5;
    let melhor = null;
    for (const el of document.querySelectorAll('aside, section, div')) {
      if (el.id === ID || el.closest(`#${ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 280 || r.width > 560 || r.height < alturaMin) continue;
      if (window.innerWidth - r.right > 24) continue;
      const pai = el.parentElement;
      if (!pai || !ehFlexRow(pai)) continue;
      // O mais externo com essa forma é o painel; os de dentro são conteúdo.
      if (!melhor || r.height > melhor.rect.height) melhor = { el, pai, rect: r };
    }
    return melhor;
  }

  /**
   * Sem Copiloto aberto: o container do layout é o flex-row mais externo que
   * ocupa quase a tela inteira e tem mais de um filho visível. É onde a lista de
   * conversas e a área de mensagens convivem — e é onde a aba cabe.
   */
  function acharContainer() {
    let melhor = null;
    for (const el of document.querySelectorAll('div, main, section')) {
      if (el.id === ID || el.closest(`#${ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.6) continue;
      if (r.height < window.innerHeight * 0.6) continue;
      if (!ehFlexRow(el)) continue;
      const filhos = [...el.children].filter((c) => c.getBoundingClientRect().width > 40);
      if (filhos.length < 2) continue;
      // O MAIS EXTERNO ganha: entrar num container interno encolheria só um
      // pedaço da tela em vez da conversa toda.
      if (!melhor || r.width * r.height > melhor.area) {
        melhor = { el, area: r.width * r.height };
      }
    }
    return melhor ? melhor.el : null;
  }

  /** Onde entrar e como. `modo` decide se empurra ou sobrepõe. */
  function decidirDestino() {
    if (window.innerWidth < LIMIAR_ESTREITO) {
      return { modo: 'sobrepoe', pai: document.body, largura: Math.min(LARGURA, window.innerWidth - 24) };
    }
    const copiloto = acharCopiloto();
    if (copiloto) {
      // Copiloto aberto é a única chance de copiar o estilo dele. Medimos
      // agora e guardamos — na próxima vez ele provavelmente estará fechado.
      const medida = medirCopiloto(copiloto.el);
      if (medida && medida.fundo) guardarEstilo(medida);
      // Mesma largura do Copiloto: as duas colunas ocupam o mesmo espaço, e
      // trocar de uma pra outra não faz a conversa pular de tamanho.
      const largura = Math.round(Math.max(LARGURA_MIN, Math.min(copiloto.rect.width, 560)));
      return { modo: 'empurra', pai: copiloto.pai, largura, referencia: copiloto.el };
    }
    const container = acharContainer();
    if (container) return { modo: 'empurra', pai: container, largura: LARGURA };
    return { modo: 'sobrepoe', pai: document.body, largura: LARGURA };
  }

  // ─── Peças ─────────────────────────────────────────────────────────────────

  function el(tag, estilo, texto) {
    const n = document.createElement(tag);
    if (estilo) n.style.cssText = estilo;
    if (texto !== undefined) n.textContent = texto;
    return n;
  }

  function botao(rotulo, p, tipo) {
    const b = el('button', '');
    b.type = 'button';
    b.textContent = rotulo;
    const primario = tipo === 'primario';
    // Altura, raio e peso vêm do botão do Copiloto quando ele foi medido —
    // é o que faz o "Começar" deles e o nosso CTA parecerem o mesmo botão.
    b.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      `min-height:${p.botaoAltura}`,
      'padding:0 14px',
      `border-radius:${p.botaoRaio}`,
      `font:${p.botaoPeso} 14px/1.2 ${p.fonte}`,
      'cursor:pointer',
      `transition:background ${TRANSICAO},border-color ${TRANSICAO},filter ${TRANSICAO}`,
      primario ? `background:${p.verde}` : 'background:transparent',
      primario ? `color:${p.botaoCor}` : `color:${p.texto}`,
      primario ? 'border:1px solid transparent' : `border:1px solid ${p.borda}`,
    ].join(';');
    b.addEventListener('mouseenter', () => {
      // Clarear por filtro em vez de trocar a cor: a cor medida no Copiloto
      // não tem um "hover" conhecido, e inventar um verde escuro romperia a
      // igualdade que acabamos de conquistar.
      if (primario) b.style.filter = 'brightness(1.08)';
      else b.style.background = p.fundoFraco;
    });
    b.addEventListener('mouseleave', () => {
      b.style.filter = 'none';
      if (!primario) b.style.background = 'transparent';
    });
    return b;
  }

  function campo(p, rotulo, opcoes) {
    const wrap = el('label', 'display:block;margin-bottom:12px');
    wrap.appendChild(
      el(
        'span',
        `display:block;margin-bottom:6px;font:500 12px/1.3 system-ui,sans-serif;color:${p.textoFraco}`,
        rotulo
      )
    );
    const entrada = el(opcoes && opcoes.select ? 'select' : 'input', '');
    entrada.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      `padding:${p.campoPadding}`,
      `border-radius:${p.campoRaio}`,
      `border:1px solid ${p.campoBorda}`,
      `background:${p.campoFundo}`,
      `color:${p.texto}`,
      `font:400 ${p.campoFonte}/1.3 ${p.fonte}`,
      'outline:none',
      `transition:border-color ${TRANSICAO}`,
    ].join(';');
    if (opcoes && opcoes.placeholder) entrada.placeholder = opcoes.placeholder;
    if (opcoes && opcoes.tipo) entrada.type = opcoes.tipo;
    entrada.addEventListener('focus', () => {
      entrada.style.borderColor = p.verde;
    });
    entrada.addEventListener('blur', () => {
      entrada.style.borderColor = p.borda;
    });
    const erro = el(
      'span',
      `display:none;margin-top:5px;font:500 11px/1.3 system-ui,sans-serif;color:${p.perigo}`
    );
    wrap.append(entrada, erro);
    return { wrap, entrada, erro };
  }

  // ─── A aba ─────────────────────────────────────────────────────────────────

  let aberto = null;

  function fechar() {
    if (!aberto) return;
    const { raiz, aoRedimensionar, aoTeclar, observer } = aberto;
    window.removeEventListener('resize', aoRedimensionar);
    document.removeEventListener('keydown', aoTeclar, true);
    if (observer) observer.disconnect();

    // Recolhe antes de sumir: tirar do DOM na hora faria a conversa dar um
    // pulo de 380 px. A largura anima de volta a zero e só então removemos.
    aberto = null;
    raiz.style.width = '0px';
    raiz.style.minWidth = '0px';
    raiz.style.opacity = '0';
    const remover = () => {
      raiz.remove();
      document.dispatchEvent(new CustomEvent('cpm-aba-fechou'));
    };
    raiz.addEventListener('transitionend', remover, { once: true });
    // Se a transição não disparar (aba já em 0, prefers-reduced-motion), o
    // nó ficaria pra sempre. O timer é a rede de segurança.
    setTimeout(remover, 400);
  }

  function estaAberta() {
    return aberto !== null;
  }

  function abrir(render) {
    fechar();
    // O destino vem PRIMEIRO porque é ele quem mede o Copiloto. Calcular a
    // paleta antes usaria os padrões na primeira abertura e só acertaria a
    // partir da segunda — e a primeira impressão é justamente a que conta.
    const destino = decidirDestino();
    const p = paleta();

    const raiz = el('div', '');
    raiz.id = ID;
    raiz.setAttribute('role', 'complementary');
    raiz.setAttribute('aria-label', 'Marcar reunião');

    const comuns = [
      `background:${p.fundo}`,
      `color:${p.texto}`,
      `border-left:1px solid ${p.borda}`,
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
      `font-family:${p.fonte}`,
      // Anima largura E opacidade: só a largura faria o texto se espremer
      // durante a abertura, que é o efeito que denuncia painel improvisado.
      `transition:width ${TRANSICAO},opacity ${TRANSICAO}`,
      'opacity:0',
      'width:0px',
    ];

    if (destino.modo === 'empurra') {
      // Irmão de flex: a conversa encolhe sozinha, sem a gente tocar nela.
      // `flex:0 0 auto` impede o container de esticar ou espremer a aba.
      raiz.style.cssText = [
        ...comuns,
        'position:relative',
        'flex:0 0 auto',
        'align-self:stretch',
        'min-width:0',
        'z-index:5',
      ].join(';');
    } else {
      // Gaveta: só quando não há espaço pra encolher.
      raiz.style.cssText = [
        ...comuns,
        'position:fixed',
        'top:0',
        'right:0',
        'height:100vh',
        'z-index:2147483646',
        'box-shadow:-8px 0 28px rgba(0,0,0,.28)',
      ].join(';');
    }

    // Cabeçalho no desenho do Copiloto: ação à esquerda, título no centro,
    // fechar à direita.
    const cabecalho = el(
      'div',
      [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:0 14px',
        `height:${p.alturaCabecalho}`,
        'flex:0 0 auto',
        'box-sizing:border-box',
        `border-bottom:1px solid ${p.borda}`,
        `background:${p.fundoTopo}`,
      ].join(';')
    );
    const voltar = el(
      'button',
      `background:none;border:none;color:${p.textoFraco};cursor:pointer;font-size:20px;` +
        'line-height:1;padding:2px 6px;border-radius:6px;visibility:hidden'
    );
    voltar.type = 'button';
    voltar.textContent = '‹';
    voltar.title = 'Voltar';

    const titulo = el('div', 'flex:1;text-align:center;min-width:0');
    const tituloTexto = el(
      'span',
      `font:${p.tituloPeso} ${p.tituloTamanho}/1.2 ${p.fonte};color:${p.texto}`,
      'Reunião'
    );
    titulo.appendChild(tituloTexto);

    const fecharBtn = el(
      'button',
      `background:none;border:none;color:${p.textoFraco};cursor:pointer;font-size:17px;` +
        'line-height:1;padding:4px 6px;border-radius:6px'
    );
    fecharBtn.type = 'button';
    fecharBtn.textContent = '✕';
    fecharBtn.title = 'Fechar';
    fecharBtn.addEventListener('click', fechar);
    for (const b of [voltar, fecharBtn]) {
      b.addEventListener('mouseenter', () => {
        b.style.background = p.fundoFraco;
        b.style.color = p.texto;
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = 'none';
        b.style.color = p.textoFraco;
      });
    }
    cabecalho.append(voltar, titulo, fecharBtn);

    const corpo = el('div', 'flex:1;overflow-y:auto;overflow-x:hidden;padding:16px 14px');
    const rodape = el(
      'div',
      `padding:12px 14px;border-top:1px solid ${p.borda};flex:0 0 auto;display:none`
    );
    raiz.append(cabecalho, corpo, rodape);

    // Entra no fim do container — a coluna mais à direita, como o Copiloto.
    destino.pai.appendChild(raiz);

    // Abre no quadro seguinte: aplicar a largura no mesmo quadro em que o nó
    // entrou faria o navegador pular a transição e a aba apareceria estalando.
    //
    // Com fallback pra setTimeout porque requestAnimationFrame NÃO dispara em
    // aba de fundo — e a aba pode ser aberta com a janela atrás de outra. Sem
    // isso ela ficaria parada em largura 0, e o atendente veria o clique não
    // fazer nada até voltar pra aba.
    const larguraAlvo = `${destino.largura}px`;
    const mostrar = () => {
      raiz.style.width = larguraAlvo;
      raiz.style.opacity = '1';
    };
    const proximoQuadro = typeof window.requestAnimationFrame === 'function'
      ? (fn) => window.requestAnimationFrame(() => window.requestAnimationFrame(fn))
      : (fn) => window.setTimeout(fn, 16);
    proximoQuadro(mostrar);
    // Rede de segurança: se o quadro não vier (aba de fundo), abre mesmo assim.
    window.setTimeout(mostrar, 120);

    const aoRedimensionar = () => {
      // Passar do limiar troca o modo, e trocar de modo exige remontar — a aba
      // é reaberta pelo fluxo, que preserva o passo em que a pessoa estava.
      const novo = decidirDestino();
      if (novo.modo !== destino.modo) {
        document.dispatchEvent(new CustomEvent('cpm-aba-remontar'));
        return;
      }
      raiz.style.width = `${novo.largura}px`;
    };
    window.addEventListener('resize', aoRedimensionar);

    const aoTeclar = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        fechar();
      }
    };
    document.addEventListener('keydown', aoTeclar, true);

    // O container é do React, que remove nós que não conhece ao re-renderizar.
    // Se a aba sumir sem a gente ter fechado, recolocamos no mesmo lugar.
    let observer = null;
    if (destino.modo === 'empurra') {
      observer = new MutationObserver(() => {
        if (aberto && !raiz.isConnected) {
          destino.pai.appendChild(raiz);
          raiz.style.width = larguraAlvo;
          raiz.style.opacity = '1';
        }
      });
      observer.observe(destino.pai, { childList: true });
    }

    aberto = { raiz, corpo, rodape, aoRedimensionar, aoTeclar, observer, modo: destino.modo };
    console.log(
      `%c[chatPro reunião]%c aba aberta — modo ${destino.modo}, ${destino.largura}px` +
        (destino.referencia ? ' (medida no Copiloto)' : ''),
      'color:#25D066;font-weight:700',
      ''
    );

    const api = {
      p,
      corpo,
      rodape,
      fechar,
      modo: destino.modo,
      cabecalho(texto, aoVoltar) {
        tituloTexto.textContent = texto;
        if (aoVoltar) {
          voltar.style.visibility = 'visible';
          voltar.onclick = aoVoltar;
        } else {
          voltar.style.visibility = 'hidden';
          voltar.onclick = null;
        }
      },
      limpar() {
        corpo.replaceChildren();
        rodape.replaceChildren();
        rodape.style.display = 'none';
      },
      acao(rotulo, aoClicar) {
        const b = botao(rotulo, p, 'primario');
        b.addEventListener('click', aoClicar);
        rodape.replaceChildren(b);
        rodape.style.display = 'block';
        return b;
      },
      campo: (rotulo, opcoes) => campo(p, rotulo, opcoes),
      botao: (rotulo, tipo) => botao(rotulo, p, tipo),
      el,
      aviso(texto, tom) {
        const cor = tom === 'erro' ? p.perigo : p.textoFraco;
        const n = el(
          'div',
          [
            'margin:-4px 0 14px',
            'padding:10px 12px',
            'border-radius:10px',
            `background:${p.fundoFraco}`,
            `color:${cor}`,
            'font:500 12px/1.45 system-ui,sans-serif',
          ].join(';'),
          texto
        );
        corpo.prepend(n);
        return n;
      },
      carregando(texto) {
        api.limpar();
        corpo.appendChild(
          el(
            'div',
            `padding:28px 8px;text-align:center;color:${p.textoFraco};` +
              'font:500 13px/1.4 system-ui,sans-serif',
            texto
          )
        );
      },
    };

    render(api);
    return api;
  }

  /**
   * Mede o Copiloto SE ele estiver aberto agora, sem abrir nada.
   *
   * Chamado pelo tick do botão. Sem isto, a medição dependeria de o Copiloto
   * estar aberto no instante exato do clique em "reunião" — e as duas colunas
   * ocupam o mesmo lugar, então quase nunca estão abertas juntas. Assim basta o
   * atendente ter usado o Copiloto uma vez, em qualquer momento, e a aba já
   * nasce com o estilo certo.
   */
  function medirSePuder() {
    if (estiloMedido) return false;
    const copiloto = acharCopiloto();
    if (!copiloto) return false;
    const medida = medirCopiloto(copiloto.el);
    if (!medida || !medida.fundo) return false;
    guardarEstilo(medida);
    console.log(
      '%c[chatPro reunião]%c estilo do Copiloto capturado — a aba vai usar as cores dele.',
      'color:#25D066;font-weight:700',
      ''
    );
    return true;
  }

  window.__cpmAba = { abrir, fechar, estaAberta, paleta, decidirDestino, medirSePuder };
})();
