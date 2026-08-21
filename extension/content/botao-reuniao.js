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
  const ROTULO = 'reunião';
  /** Texto dos botões vizinhos — usados como âncora e como molde. */
  const VIZINHOS = ['transferir', 'etiquetas', 'agendar', 'finalizar'];
  const INTERVALO_MS = 1500;


  let ultimaSessao = null;
  let avisouSemBarra = false;
  /** Instante do último clique aceito — barra o mesmo clique chegando 2x. */
  let ultimoClique = 0;

  // ─── Utilidades ────────────────────────────────────────────────────────────

  const log = (...a) => console.log('%c[chatPro reunião]', 'color:#25D066;font-weight:700', ...a);

  // Anúncio no carregamento: se esta linha não aparece no console, o Chrome
  // está com OUTRA cópia da extensão carregada — foi o que já aconteceu aqui.
  log(`v${chrome.runtime.getManifest().version} carregada`);

  // Este arquivo depende de três outros, e quem os carrega é o manifest — que
  // o Chrome só relê ao RECARREGAR a extensão. Dar F5 na página deixa este
  // arquivo atualizado e os outros ausentes, e aí o botão aparece mas não abre
  // nada. Conferir no carregamento transforma isso numa linha no console em vez
  // de um clique que não responde.
  const ausentes = [
    !window.__cpmAtendente && 'content/atendente.js',
    !window.__cpmAba && 'content/aba-reuniao.js',
    !window.__cpmFluxo && 'content/fluxo-reuniao.js',
  ].filter(Boolean);
  if (ausentes.length > 0) {
    console.error(
      '[chatPro reunião] Estes arquivos não foram carregados: ' +
        ausentes.join(', ') +
        '.\nO manifest em memória não lista eles. Vá em chrome://extensions e clique ' +
        'em RECARREGAR na extensão (F5 na página não resolve).'
    );
  }

  function sessaoAtual() {
    const m = /\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    return m ? m[1] : null;
  }

  // ─── Atendente (localStorage do chatPro) ───────────────────────────────────




  // ─── CNPJ e telefone ───────────────────────────────────────────────────────





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

  /**
   * Câmera do Phosphor (`video-camera`, peso fill) — o mesmo desenho que o
   * chatPro usa na barra, então o botão não parece enxertado de outro produto.
   *
   * `fill="currentColor"` NÃO é detalhe: o arquivo baixado vinha com
   * `fill="#000000"` cravado, e cor literal aqui some no tema escuro, onde a
   * barra é preta. Herdando a cor do texto, o ícone acompanha os vizinhos nos
   * dois temas — foi assim que a seta de voltar foi resolvida.
   */
  function svgCamera(tamanho) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho}" height="${tamanho}" ` +
      'viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' +
      '<path d="M251.77,73a8,8,0,0,0-8.21.39L208,97.05V72a16,16,0,0,0-16-16H32A16,16,0,0,0,' +
      '16,72V184a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V159l35.56,23.71A8,8,0,0,0,248,184a8,' +
      '8,0,0,0,8-8V80A8,8,0,0,0,251.77,73ZM192,184H32V72H192V184Zm48-22.95-32-21.33V116.28L240,' +
      '95Z"></path></svg>'
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

    // O clone herda as classes do chatPro, e junto pode vir um
    // `pointer-events: none` (comum em botão que só é clicável por um filho, ou
    // que estava desabilitado no momento da cópia). O clique então atravessa o
    // botão e nada acontece — sem erro nenhum no console, que é o pior tipo de
    // falha. Forçar aqui custa nada e fecha essa porta.
    clone.style.pointerEvents = 'auto';
    clone.style.cursor = 'pointer';
    // Sobe acima de overlay invisível que porventura cubra a barra.
    if (getComputedStyle(clone).position === 'static') clone.style.position = 'relative';
    clone.style.zIndex = '10';
    clone.removeAttribute('disabled');
    clone.removeAttribute('aria-disabled');

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

  /**
   * Cartão com o `<input type="datetime-local">` nativo. Nativo de propósito:
   * o seletor de data do próprio navegador já é acessível, já fala o idioma do
   * usuário e não pesa nada — um calendário próprio aqui seria manutenção sem
   * ganho, dentro de uma página que não é nossa.
   */






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

  /**
   * O telefone do cliente, pra já entrar preenchido no formulário — o painel
   * exige e ele está bem ali, na própria conversa.
   *
   * A conversa do chatPro é de WhatsApp: o número aparece no cabeçalho ou no
   * `href` de algum link. Não achando, o atendente digita — por isso null é um
   * resultado aceitável, não uma falha.
   */
  function telefoneDoContato() {
    const RE = /(?:\+?55)?\s*\(?(\d{2})\)?\s*(\d{4,5})[-\s]?(\d{4})/;
    for (const el of document.querySelectorAll('a[href*="wa.me"], a[href^="tel:"]')) {
      const m = RE.exec(el.getAttribute('href') || '');
      if (m) return `${m[1]}${m[2]}${m[3]}`;
    }
    // Cabeçalho da conversa: mesma faixa onde o nome aparece.
    for (const el of document.querySelectorAll('span,div,p')) {
      const r = el.getBoundingClientRect();
      if (r.top > 130 || r.top < 40 || r.left < 380) continue;
      if (el.children.length > 0) continue;
      const m = RE.exec((el.textContent || '').trim());
      if (m) return `${m[1]}${m[2]}${m[3]}`;
    }
    return null;
  }


  // ─── Injeção ───────────────────────────────────────────────────────────────

  function injetar() {
    const sessao = sessaoAtual();
    // TODOS, não só o primeiro: se por algum motivo dois botões nossos
    // existirem ao mesmo tempo (React remontou a barra entre a checagem e a
    // inserção), `getElementById` devolveria só um e o outro ficaria órfão na
    // tela, com listener próprio. Dois listeners para o mesmo clique abrem e
    // fecham a aba no mesmo instante — que se parece exatamente com "o botão
    // não faz nada".
    const existentes = document.querySelectorAll(`#${ID}`);

    // Sem conversa aberta, o botão não faz sentido.
    if (!sessao) {
      for (const el of existentes) el.remove();
      if (window.__cpmAba) window.__cpmAba.fechar();
      return;
    }

    if (existentes.length === 1 && existentes[0].isConnected) {
      ultimaSessao = sessao;
      return;
    }
    // Sobrou mais de um (ou o único está solto): limpa e refaz do zero.
    for (const el of existentes) el.remove();

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

      // Um clique tem que virar UMA ação. Se o mesmo clique chegar aqui duas
      // vezes (listener duplicado, botão aninhado, evento sintético do React),
      // a primeira abriria a aba e a segunda fecharia — e o resultado visível
      // seria "o botão não faz nada", sem erro nenhum pra investigar.
      const agora = Date.now();
      if (agora - ultimoClique < 400) {
        log('clique repetido em menos de 400 ms — ignorado (seria abre-e-fecha).');
        return;
      }
      ultimoClique = agora;
      // Log em cada etapa do clique. O console do DevTools abre no contexto da
      // PÁGINA, e content script roda em mundo isolado — então não dá pra pedir
      // pra pessoa chamar uma função nossa no console sem antes trocar o
      // contexto no seletor. Logar sozinho evita esse passo.
      log('1/4 clique recebido');
      // O clique abre a escolha: "Agora" ou "Agendar".
      //
      // Antes, clicar criava a reunião na hora e agendar exigia segurar Shift.
      // Ninguém descobre um atalho invisível — e o clique disparava algo
      // irreversível (bot na sala, mensagem pro cliente) sem confirmação. Uma
      // tela intermediária custa um clique e resolve os dois problemas.
      //
      // O fluxo inteiro mora numa ABA LATERAL, no mesmo lugar do Copiloto: são
      // quatro passos e o atendente precisa continuar lendo a conversa pra
      // preencher nome, empresa e telefone. Um cartão flutuante tapava
      // exatamente o que ele precisava ver.
      const sessao = sessaoAtual();
      if (!sessao) {
        log('2/4 PAROU: nenhuma conversa aberta (a URL não tem /chat/<uuid>).');
        avisar('Abra uma conversa antes de marcar a reunião.', 'erro');
        return;
      }
      log(`2/4 conversa ${sessao}`);

      // Clicar de novo com a aba aberta fecha, como qualquer painel lateral.
      if (window.__cpmAba && window.__cpmAba.estaAberta()) {
        log('3/4 a aba já estava aberta — fechando (é o toggle).');
        window.__cpmAba.fechar();
        return;
      }

      // Os três ajudantes vêm de OUTROS arquivos, declarados no manifest. E o
      // manifest só é relido quando a extensão é recarregada — dar F5 na página
      // não basta. Então dá pra cair aqui com este arquivo já atualizado e os
      // outros três nunca carregados: o botão aparece e o clique não faz nada.
      //
      // Já aconteceu, e o pior foi o silêncio. Aqui a falha vira instrução.
      const faltando = [
        !window.__cpmAtendente && 'atendente.js',
        !window.__cpmAba && 'aba-reuniao.js',
        !window.__cpmFluxo && 'fluxo-reuniao.js',
      ].filter(Boolean);
      if (faltando.length > 0) {
        const versao = chrome.runtime.getManifest().version;
        log(
          `FALTANDO: ${faltando.join(', ')}. O manifest carregado é o da v${versao} ` +
            'e não lista esses arquivos. Recarregue a extensão em chrome://extensions ' +
            '(o botão de recarregar), não só F5 na página.'
        );
        avisar(
          'Recarregue a extensão em chrome://extensions — a página sozinha não ' +
            'atualiza os arquivos novos.',
          'erro'
        );
        return;
      }

      log('3/4 abrindo a aba…');
      try {
        window.__cpmFluxo.iniciar({
          sessionId: sessao,
          contato: nomeDoContato(),
          telefone: telefoneDoContato(),
        });
      } catch (err) {
        // Sem isto, uma exceção aqui morre no listener e o clique parece
        // simplesmente não fazer nada.
        console.error('[chatPro reunião] a abertura da aba estourou:', err);
        avisar('Erro ao abrir a reunião. Veja o console (F12).', 'erro');
        return;
      }

      // Confirma que a aba nasceu E onde: aba criada fora da tela produz o
      // mesmo sintoma de botão quebrado.
      const criada = document.getElementById('cpm-aba-reuniao');
      if (!criada) {
        console.error('[chatPro reunião] 4/4 a aba NÃO foi criada no DOM.');
        return;
      }
      const r = criada.getBoundingClientRect();
      const naTela = r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
      log(
        `4/4 aba criada (${Math.round(r.width)}x${Math.round(r.height)} em ` +
          `top:${Math.round(r.top)} left:${Math.round(r.left)}) — ` +
          (naTela ? 'visível' : 'FORA DA TELA')
      );
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
  /**
   * A conversa que estava aberta na última verificação.
   *
   * Fica SEPARADA de `ultimaSessao` de propósito: aquela é atualizada dentro de
   * `injetar()`, e `injetar()` roda tanto pelo observer quanto pelo tick de
   * 1,5 s. Quem chegasse primeiro apagaria a evidência da troca, e o outro
   * nunca veria — a aba ficaria aberta com os dados de um cliente e o
   * sessionId de outro. Com um marcador próprio, os dois caminhos concordam.
   */
  let sessaoVigiada = sessaoAtual();

  function conferirTroca() {
    const agora = sessaoAtual();
    if (agora === sessaoVigiada) return;
    sessaoVigiada = agora;
    const antigo = document.getElementById(ID);
    if (antigo) antigo.remove();
    // Trocou de conversa: qualquer tela aberta marcaria pro cliente errado.
    if (window.__cpmAba && window.__cpmAba.estaAberta()) {
      window.__cpmAba.fechar();
      avisar('A conversa mudou — fechei a tela de reunião pra não marcar pro cliente errado.');
    }
    // Usuário pode ter trocado junto (outro login na mesma aba).
    if (window.__cpmAtendente) window.__cpmAtendente.esquecer();
  }

  const observer = new MutationObserver(() => {
    conferirTroca();
    injetar();
    // Aproveita qualquer momento em que o Copiloto esteja aberto pra copiar o
    // estilo dele. Custa nada quando já foi medido (sai na primeira linha).
    if (window.__cpmAba) window.__cpmAba.medirSePuder();
  });

  /**
   * `__cpmDiag()` no console: conta tudo que importa quando o botão não abre a
   * aba. É o que evita mais uma rodada de adivinhação — mostra se os arquivos
   * carregaram, se o botão está clicável, onde a aba iria parar, e força uma
   * abertura sem depender do clique.
   */
  window.__cpmDiag = function diagnosticar() {
    const botao = document.getElementById(ID);
    const todos = document.querySelectorAll(`#${ID}`);
    const r = botao ? botao.getBoundingClientRect() : null;
    const estilo = botao ? getComputedStyle(botao) : null;

    // O que estaria por cima do centro do botão — se não for ele mesmo (nem um
    // filho dele), tem overlay comendo o clique.
    let porCima = null;
    if (r && r.width > 0) {
      const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      porCima = alvo ? (botao.contains(alvo) ? 'o próprio botão' : alvo.tagName + '.' + (alvo.className || '?')) : 'nada';
    }

    const info = {
      versao: chrome.runtime.getManifest().version,
      scripts: {
        atendente: Boolean(window.__cpmAtendente),
        aba: Boolean(window.__cpmAba),
        fluxo: Boolean(window.__cpmFluxo),
      },
      sessao: sessaoAtual(),
      botao: {
        achou: Boolean(botao),
        quantos: todos.length,
        tamanho: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null,
        pointerEvents: estilo ? estilo.pointerEvents : null,
        visibility: estilo ? estilo.visibility : null,
        display: estilo ? estilo.display : null,
        quemRecebeOClique: porCima,
      },
      abaAberta: window.__cpmAba ? window.__cpmAba.estaAberta() : null,
      atendente: window.__cpmAtendente ? window.__cpmAtendente.detectar() : null,
      chavesDoStorage: window.__cpmAtendente ? window.__cpmAtendente.diagnosticar() : null,
    };
    console.log('[chatPro reunião] diagnóstico:', info);

    // Abre sem passar pelo clique: separa "o clique não chega" de "a aba não abre".
    try {
      window.__cpmFluxo.iniciar({
        sessionId: sessaoAtual(),
        contato: nomeDoContato(),
        telefone: telefoneDoContato(),
      });
      const aba = document.getElementById('cpm-aba-reuniao');
      const ar = aba ? aba.getBoundingClientRect() : null;
      console.log(
        '[chatPro reunião] abertura direta:',
        aba
          ? `aba criada em top:${Math.round(ar.top)} right:${Math.round(window.innerWidth - ar.right)} ` +
              `${Math.round(ar.width)}x${Math.round(ar.height)}`
          : 'a aba NÃO foi criada'
      );
    } catch (err) {
      console.error('[chatPro reunião] abrir direto estourou:', err);
    }
    return info;
  };

  function iniciar() {
    injetar();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      conferirTroca();
      injetar();
    }, INTERVALO_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
