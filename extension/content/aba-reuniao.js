/**
 * A aba "Reunião" — um painel lateral dentro do chatPro, no mesmo lugar e com
 * o mesmo comportamento do Copiloto.
 *
 * POR QUE UM PAINEL E NÃO UM MODAL: o fluxo tem quatro passos (tipo → dados do
 * cliente → dia e horário → confirmação) e o atendente precisa continuar vendo
 * a conversa enquanto preenche — é de lá que ele tira nome, empresa e telefone.
 * Um modal centralizado tapa exatamente o que ele precisa ler.
 *
 * COMO ELE ACHA O LUGAR CERTO, sem depender das classes internas do chatPro
 * (que mudam a cada deploy e quebrariam em silêncio):
 *
 *   1. Se o Copiloto estiver aberto, medimos ELE e ocupamos o mesmo retângulo.
 *      É o caminho exato — mesma largura, mesma altura, mesmo topo.
 *   2. Se não estiver, procuramos a coluna da direita por geometria: um
 *      elemento alto, encostado na borda direita, com largura de painel.
 *   3. Não achando nada, caímos numa gaveta fixa de 360 px na direita.
 *
 * Os três caminhos produzem o mesmo desenho; só a precisão do encaixe muda.
 * Nenhum depende de nome de classe.
 */

(() => {
  'use strict';

  const ID = 'cpm-aba-reuniao';
  const LARGURA_PADRAO = 360;

  // ─── Tema ──────────────────────────────────────────────────────────────────

  function escuro() {
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    if (!m) return document.documentElement.classList.contains('dark');
    // Luminância perceptual: fundo escuro do chatPro fica bem abaixo de 128.
    const luz = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
    return luz < 128;
  }

  function paleta() {
    const e = escuro();
    return {
      escuro: e,
      fundo: e ? '#22272b' : '#ffffff',
      fundoFraco: e ? '#2c333a' : '#f1f0f2',
      texto: e ? '#E6E5E8' : '#1d2125',
      textoFraco: e ? '#9aa4ad' : '#6b7280',
      borda: e ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.10)',
      verde: '#25D066',
      verdeHover: '#1BAD53',
      perigo: e ? '#ff6b6b' : '#c92a2a',
    };
  }

  // ─── Onde o painel vai ─────────────────────────────────────────────────────

  /**
   * Acha o painel do Copiloto pela ESTRUTURA, não pelo nome: um bloco alto,
   * encostado à direita, com largura de painel lateral. Procurar pelo texto
   * "Copiloto" também funcionaria, mas só enquanto ele estiver aberto — e o
   * ponto é justamente ocupar o lugar dele quando está fechado.
   */
  function medirColunaDireita() {
    const alturaMin = window.innerHeight * 0.5;
    const direita = window.innerWidth;
    let melhor = null;

    for (const el of document.querySelectorAll('div, aside, section')) {
      const r = el.getBoundingClientRect();
      if (r.width < 260 || r.width > 560) continue;
      if (r.height < alturaMin) continue;
      // Encostado na borda direita (tolerância pra sombra/scrollbar).
      if (direita - r.right > 24) continue;
      // O mais externo com essa forma é o painel; os de dentro são o conteúdo.
      if (!melhor || r.width > melhor.width || r.height > melhor.height) {
        melhor = { top: r.top, right: direita - r.right, width: r.width, height: r.height };
      }
    }
    return melhor;
  }

  function geometria() {
    const medida = medirColunaDireita();
    // Nada encontrado: gaveta fixa, abaixo de qualquer barra de topo.
    const bruta = medida ?? {
      top: 56,
      right: 0,
      width: LARGURA_PADRAO,
      height: window.innerHeight - 56,
    };

    // A medida vem de um elemento da página, e elemento de página pode estar
    // rolado pra fora (top negativo), maior que a janela, ou deslocado. Se
    // qualquer um desses valores passasse direto, a aba abriria FORA DA TELA —
    // e o sintoma seria "cliquei e não aconteceu nada", que é indistinguível
    // de um botão quebrado.
    const top = Math.max(0, Math.min(bruta.top, window.innerHeight - 200));
    const width = Math.max(300, Math.min(bruta.width, window.innerWidth - 40));
    const right = Math.max(0, Math.min(bruta.right, window.innerWidth - width));
    const height = Math.max(240, Math.min(bruta.height, window.innerHeight - top));
    return { top, right, width, height };
  }

  // ─── Peças de UI ───────────────────────────────────────────────────────────

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
    b.style.cssText = [
      'width:100%',
      'padding:11px 14px',
      'border-radius:10px',
      'font:600 14px/1.2 system-ui,-apple-system,Segoe UI,sans-serif',
      'cursor:pointer',
      'transition:background .15s,border-color .15s',
      primario ? `background:${p.verde}` : 'background:transparent',
      primario ? 'color:#0b2016' : `color:${p.texto}`,
      primario ? 'border:1px solid transparent' : `border:1px solid ${p.borda}`,
    ].join(';');
    b.addEventListener('mouseenter', () => {
      b.style.background = primario ? p.verdeHover : p.fundoFraco;
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = primario ? p.verde : 'transparent';
    });
    return b;
  }

  function campo(p, rotulo, opcoes) {
    const wrap = el('label', 'display:block;margin-bottom:12px');
    const t = el(
      'span',
      `display:block;margin-bottom:6px;font:500 12px/1.3 system-ui,sans-serif;color:${p.textoFraco}`,
      rotulo
    );
    wrap.appendChild(t);

    const entrada = el(opcoes && opcoes.select ? 'select' : 'input', '');
    entrada.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'padding:10px 12px',
      'border-radius:10px',
      `border:1px solid ${p.borda}`,
      `background:${p.escuro ? '#1d2125' : '#fff'}`,
      `color:${p.texto}`,
      'font:400 14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif',
      'outline:none',
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
    wrap.appendChild(entrada);
    wrap.appendChild(erro);
    return { wrap, entrada, erro };
  }

  // ─── O painel ──────────────────────────────────────────────────────────────

  let aberto = null;

  function fechar() {
    if (!aberto) return;
    window.removeEventListener('resize', aberto.reposicionar);
    document.removeEventListener('keydown', aberto.aoTeclar, true);
    aberto.raiz.remove();
    aberto = null;
    document.dispatchEvent(new CustomEvent('cpm-aba-fechou'));
  }

  function estaAberta() {
    return aberto !== null;
  }

  /**
   * Abre a aba. `render(corpo, api)` desenha o conteúdo; `api` traz o que os
   * passos precisam (paleta, trocar de passo, fechar, rodapé).
   */
  function abrir(render) {
    fechar();
    const p = paleta();
    const g = geometria();

    const raiz = el('div', '');
    raiz.id = ID;
    raiz.setAttribute('role', 'dialog');
    raiz.setAttribute('aria-label', 'Marcar reunião');
    raiz.style.cssText = [
      'position:fixed',
      `top:${Math.round(g.top)}px`,
      `right:${Math.round(g.right)}px`,
      `width:${Math.round(g.width)}px`,
      `height:${Math.round(g.height)}px`,
      'z-index:2147483646',
      `background:${p.fundo}`,
      `color:${p.texto}`,
      `border-left:1px solid ${p.borda}`,
      'box-shadow:-8px 0 24px rgba(0,0,0,.18)',
      'display:flex',
      'flex-direction:column',
      'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
    ].join(';');

    // Cabeçalho no mesmo desenho do Copiloto: ação à esquerda, título no meio,
    // fechar à direita.
    const cabecalho = el(
      'div',
      [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:14px 14px',
        `border-bottom:1px solid ${p.borda}`,
        'flex:0 0 auto',
      ].join(';')
    );
    const voltar = el(
      'button',
      `background:none;border:none;color:${p.textoFraco};cursor:pointer;font-size:18px;` +
        'line-height:1;padding:4px;visibility:hidden'
    );
    voltar.type = 'button';
    voltar.textContent = '‹';
    voltar.title = 'Voltar';
    const titulo = el(
      'div',
      'flex:1;text-align:center;font:600 15px/1.2 system-ui,sans-serif',
      'Reunião'
    );
    const fecharBtn = el(
      'button',
      `background:none;border:none;color:${p.textoFraco};cursor:pointer;font-size:18px;` +
        'line-height:1;padding:4px'
    );
    fecharBtn.type = 'button';
    fecharBtn.textContent = '✕';
    fecharBtn.title = 'Fechar';
    fecharBtn.addEventListener('click', fechar);
    cabecalho.append(voltar, titulo, fecharBtn);

    const corpo = el('div', 'flex:1;overflow-y:auto;padding:16px 14px');
    const rodape = el(
      'div',
      `padding:12px 14px;border-top:1px solid ${p.borda};flex:0 0 auto;display:none`
    );

    raiz.append(cabecalho, corpo, rodape);
    document.body.appendChild(raiz);

    const reposicionar = () => {
      const novo = geometria();
      raiz.style.top = `${Math.round(novo.top)}px`;
      raiz.style.right = `${Math.round(novo.right)}px`;
      raiz.style.width = `${Math.round(novo.width)}px`;
      raiz.style.height = `${Math.round(novo.height)}px`;
    };
    window.addEventListener('resize', reposicionar);

    const aoTeclar = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        fechar();
      }
    };
    document.addEventListener('keydown', aoTeclar, true);

    aberto = { raiz, corpo, rodape, reposicionar, aoTeclar };

    const api = {
      p,
      corpo,
      rodape,
      fechar,
      /** Título do cabeçalho e o botão voltar, que só aparece quando há pra onde. */
      cabecalho(texto, aoVoltar) {
        titulo.textContent = texto;
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
      /** Aviso curto no topo do corpo — erro de API, campo faltando, etc. */
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
      /** Estado de carregando, com o texto do que está esperando. */
      carregando(texto) {
        api.limpar();
        corpo.appendChild(
          el(
            'div',
            `padding:28px 8px;text-align:center;color:${p.textoFraco};font:500 13px/1.4 system-ui,sans-serif`,
            texto
          )
        );
      },
    };

    render(api);
    return api;
  }

  window.__cpmAba = { abrir, fechar, estaAberta, paleta };
})();
