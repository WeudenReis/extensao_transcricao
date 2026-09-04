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
/* Seletor DESCENDENTE, e não filho direto de .copilot-list: as
   listas movem o <article> da seção pra dentro de um <div> (pra poder limpar
   só aquele pedaço), e o seletor de FILHO DIRETO deixava de casar — a lista
   inteira ficava sem separação, sem hover e sem hierarquia. O :not() exclui
   o article de rolagem da própria aba, que não é lista. */
.copilot--reuniao article:not(.copilot-article) > a{
  display:block;-webkit-line-clamp:none;line-clamp:none;
  padding:10px 0;border-bottom:1px solid hsl(var(--gray-10));
  color:inherit;cursor:pointer;transition:all .1s;text-decoration:none}
/* O hover pinta a faixa inteira, e não só clareia o texto: numa lista de dez
   reuniões parecidas, saber QUAL linha o clique vai pegar importa mais que o
   efeito ser discreto. O recuo negativo faz a faixa sangrar até a borda. */
.copilot--reuniao article:not(.copilot-article) > a:hover{
  opacity:1;background:hsl(var(--gray-10));
  margin:0 calc(var(--padding-xs) * -1);padding-left:var(--padding-xs);
  padding-right:var(--padding-xs);border-radius:var(--radius-sm,6px)}
/* Nome de empresa é longo ("EMPRESA BRASILEIRA DE COMUNICACAO PRODUCAO LTDA")
   e quebrava em três linhas, empurrando o horário pra longe do nome. Duas
   linhas no máximo, com reticências. */
.copilot--reuniao article:not(.copilot-article) > a > div > span{
  display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden;line-height:1.35}
.copilot--reuniao article:not(.copilot-article) > a:last-child{border-bottom:0}
.copilot--reuniao article:not(.copilot-article) > a > div{
  display:flex;flex-direction:row;justify-content:space-between}
.copilot--reuniao article:not(.copilot-article) > a > div > span{
  font-size:1rem;font-weight:400;color:hsl(var(--gray-80))}
.copilot--reuniao article:not(.copilot-article) > a > span{
  display:block;font-size:.6875rem;color:hsl(var(--gray-50))}
.copilot--reuniao header:not(.copilot-header) h1{
  font-size:1rem;font-weight:700;color:hsl(var(--gray-80))}

/* ── O que o Copiloto não tem ── */
.copilot--reuniao .cpm-erro{
  display:none;font-size:.6875rem;color:hsl(var(--color-red,0 72% 51%))}
.copilot--reuniao .cpm-invalido{
  border-color:hsl(var(--color-red,0 72% 51%))!important;
  box-shadow:0 0 0 1px hsl(var(--color-red,0 72% 51%) / .30)}
.copilot--reuniao .cpm-nota{
  padding:var(--padding-xs);border-radius:var(--radius-md);
  background:hsl(var(--gray-10));font-size:.8125rem;line-height:1.45}
/* Os dois botões de ícone do cabeçalho. O .button--empty do chatPro tem
   padding pensado pra texto (0 .5em), o que deixa o ícone descentralizado e o
   alvo de clique estreito. Aqui vira um quadrado de 40px com o ícone no meio —
   a mesma proporção dos ícones do Copiloto. */
.copilot--reuniao .copilot-header .button--empty{
  width:40px;padding:0;flex:0 0 auto}
.copilot--reuniao .copilot-header .button--empty svg{display:block}
/* Voltar escondido continua ocupando o lugar: sem isso o h1 sai do centro
   quando a seta some, e o título "pula" a cada passo. */
.copilot--reuniao .copilot-header .button--empty[hidden]{
  display:inline-flex;visibility:hidden}

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
/* ── Calendário do mês, no desenho do painel adaptado a 450px ──
   O painel tem largura de tela cheia e cabem chips com o nome de cada
   reunião. Aqui cada coluna tem ~55px: o nome não cabe de jeito nenhum, então
   o dia carrega PONTOS (um por reunião, até 3) e a lista do dia abre embaixo
   ao clicar. Mesma informação, na ordem que a largura permite. */
.copilot--reuniao .cpm-cal-topo{
  display:flex;align-items:center;justify-content:space-between;
  gap:.5rem;margin-bottom:.75rem}
.copilot--reuniao .cpm-cal-mes{
  font-size:.9375rem;font-weight:700;color:hsl(var(--gray-80));
  text-transform:capitalize;flex:1;text-align:center}
.copilot--reuniao .cpm-cal-nav{
  width:32px;height:32px;flex:0 0 auto;padding:0;border-radius:var(--radius-sm,6px);
  border:1px solid hsl(var(--gray-10));background:hsl(var(--gray-00));
  color:hsl(var(--gray-80));cursor:pointer;font-family:inherit;font-size:1rem;
  display:flex;align-items:center;justify-content:center;transition:all .1s}
.copilot--reuniao .cpm-cal-hoje{
  flex:0 0 auto;padding:0 .625rem;height:32px;border-radius:var(--radius-sm,6px);
  border:1px solid hsl(var(--gray-10));background:hsl(var(--gray-00));
  color:hsl(var(--gray-80));cursor:pointer;font-family:inherit;
  font-size:.75rem;font-weight:600;transition:all .1s}
.copilot--reuniao .cpm-cal-hoje:hover{
  border-color:hsl(var(--gray-20));background:hsl(var(--gray-05))}
.copilot--reuniao .cpm-cal-nav:hover{
  border-color:hsl(var(--gray-20));background:hsl(var(--gray-05))}
.copilot--reuniao .cpm-cal-semana,
.copilot--reuniao .cpm-cal-grade{
  display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.copilot--reuniao .cpm-cal-semana{margin-bottom:3px}
.copilot--reuniao .cpm-cal-dia-nome{
  font-size:.625rem;font-weight:600;color:hsl(var(--gray-50));
  text-align:center;text-transform:uppercase;letter-spacing:.02em}
.copilot--reuniao .cpm-cal-dia{
  min-height:34px;border-radius:var(--radius-sm,6px);
  border:1px solid transparent;background:transparent;
  color:hsl(var(--gray-80));cursor:pointer;font-family:inherit;
  font-size:.8125rem;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:1px;padding:2px 0;transition:all .1s;
  overflow:hidden}
.copilot--reuniao .cpm-cal-dia:hover{background:hsl(var(--gray-10))}
/* Dia de outro mês continua clicável, mas apagado: é contexto de borda de
   grade, não conteúdo — e sumir com ele deixaria buracos na primeira linha. */
/* --gray-50 e não --gray-20: o 20 é tom de BORDA e, usado como texto,
   sumia contra o fundo. O 50 é o tom de texto secundário que o resto do
   arquivo já usa — apagado em relação ao --gray-80 do dia do mês, mas legível. */
.copilot--reuniao .cpm-cal-dia--fora{color:hsl(var(--gray-50))}
/* HOJE é contorno, não preenchimento: preenchido brigaria com o dia
   selecionado, e os dois podem ser o mesmo dia. */
.copilot--reuniao .cpm-cal-dia--hoje{
  border-color:hsl(var(--cpm-evento));font-weight:700}
.copilot--reuniao .cpm-cal-dia--escolhido,
.copilot--reuniao .cpm-cal-dia--escolhido:hover{
  background:hsl(var(--lime-green-50));border-color:hsl(var(--lime-green-50));
  color:hsl(var(--gray-00));font-weight:700}
.copilot--reuniao .cpm-cal-pontos{
  display:flex;gap:2px;height:4px;align-items:center}
.copilot--reuniao .cpm-cal-ponto{
  width:4px;height:4px;border-radius:50%;background:hsl(var(--cpm-evento))}
.copilot--reuniao .cpm-cal-dia--escolhido .cpm-cal-ponto{
  background:hsl(var(--gray-00))}
/* ── A cor dos eventos do calendário ──
   Um nome próprio, e não --cool-green-70 direto, porque esse token resolve
   AZULADO no chatPro real: na tela do time os chips saíam cinza-azulados e o
   anel de "hoje" ficava azul, nada parecido com o que a demonstração mostrava.
   --lime-green-50 é o verde vivo de verdade — é ele que pinta o dia
   selecionado, e no print do time apareceu verde como esperado.

   O fallback existe pra demonstração e pra qualquer contexto sem o design
   system: é o verde da identidade do chatPro, o mesmo do CLAUDE.md. Fica no
   fallback de uma variável, nunca como cor solta numa regra — cor solta é o
   que quebra o tema claro. */
.copilot--reuniao{--cpm-evento:var(--lime-green-50,142 69% 48%)}

/* ── Modo LARGO ──
   A coluna de 450px cabe o mês inteiro, mas só com pontinhos: 55px não
   comportam nome de cliente. Alargando, cada dia vira uma célula alta com
   chips nomeados — o desenho do painel, que só faltava espaço pra existir.

   O min(58vw, 760px) e nao um numero fixo: a aba divide a tela com a
   conversa, e 760px num notebook de 1280 deixaria o chat inutilizável.
   O :not(.active) acompanha o fechamento — sem ele a aba fecharia deixando
   uma faixa de 300px pra fora, porque o chatPro esconde com margem negativa
   do tamanho ANTIGO. */
.copilot--reuniao.cpm-largo{flex-basis:min(58vw,760px)}
.copilot--reuniao.cpm-largo:not(.active){margin-right:calc(min(58vw,760px) * -1)}
.copilot--reuniao.cpm-largo .cpm-cal-dia{
  min-height:74px;justify-content:flex-start;align-items:stretch;
  padding:3px;gap:2px}
.copilot--reuniao.cpm-largo .cpm-cal-num{
  text-align:left;padding-left:2px;font-size:.75rem}
/* Os pontinhos são o resumo de quem não tem espaço pra nome; com nome na
   tela eles viram ruído. Os dois convivem no DOM e o CSS escolhe — trocar no
   JS exigiria redesenhar a grade a cada mudança de largura. */
.copilot--reuniao.cpm-largo .cpm-cal-pontos{display:none}
.copilot--reuniao .cpm-cal-chips{display:none}
.copilot--reuniao.cpm-largo .cpm-cal-chips{
  display:flex;flex-direction:column;gap:2px;overflow:hidden}
/* O chip precisa se destacar do fundo do dia, senão a grade vira um borrão
   claro — foi o que aconteceu com 16% de opacidade na tela real. Fundo mais
   forte, texto em peso 600 e uma barra da cor cheia na borda esquerda, que é
   o que dá a leitura de "evento" à distância. */
.copilot--reuniao .cpm-cal-chip{
  font-size:.625rem;font-weight:600;line-height:1.35;
  padding:1px 4px 1px 3px;border-radius:3px;
  border:1px solid hsl(var(--cpm-evento) / .55);
  border-left:3px solid hsl(var(--cpm-evento));
  background:hsl(var(--cpm-evento) / .22);color:hsl(var(--gray-80));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;
  display:flex;align-items:center;gap:3px}
.copilot--reuniao .cpm-cal-chip svg{
  flex:0 0 auto;width:9px;height:9px;fill:currentColor;opacity:.85}
.copilot--reuniao .cpm-cal-chip span{
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* O "+2" não é um evento, é uma contagem: caixa em volta dele prometeria
   uma reunião a mais que não existe. */
.copilot--reuniao .cpm-cal-chip--mais{
  background:transparent;border-color:transparent;
  color:hsl(var(--gray-50));padding-left:5px;font-weight:400}
.copilot--reuniao.cpm-largo .cpm-cal-dia--escolhido .cpm-cal-chip{
  background:hsl(var(--gray-00) / .28);border-color:hsl(var(--gray-00) / .65);
  border-left-color:hsl(var(--gray-00));color:hsl(var(--gray-00))}
.copilot--reuniao.cpm-largo .cpm-cal-dia--escolhido .cpm-cal-chip--mais{
  background:transparent;color:hsl(var(--gray-00))}
/* No modo largo o dia da semana ganha o nome inteiro — cabe, e "SEG" existia
   só pela falta de espaço. */
.copilot--reuniao.cpm-largo .cpm-cal-dia-nome{font-size:.6875rem}
/* Botão de alargar/estreitar, ao lado do Hoje. */
.copilot--reuniao .cpm-cal-largura{
  flex:0 0 auto;width:32px;height:32px;padding:0;
  border-radius:var(--radius-sm,6px);border:1px solid hsl(var(--gray-10));
  background:hsl(var(--gray-00));color:hsl(var(--gray-80));cursor:pointer;
  font-family:inherit;font-size:.875rem;line-height:1;
  display:flex;align-items:center;justify-content:center;transition:all .1s}
.copilot--reuniao .cpm-cal-largura:hover{
  border-color:hsl(var(--gray-20));background:hsl(var(--gray-05))}

/* ── Vista SEMANA ──
   Sete LINHAS, não sete colunas. O painel usa colunas porque tem a tela
   inteira; aqui a coluna do dia teria ~55px estreita e ~100px larga, e o nome
   do cliente — que é o motivo de existir esta vista — não caberia em nenhuma
   das duas. Em linha, cada dia usa a largura toda e a reunião aparece por
   extenso: hora, tipo e cliente, que é o "mais explícito" que a semana promete.
   Bônus: a mesma marcação serve nas duas larguras, sem layout duplicado. */
.copilot--reuniao .cpm-sem-dia{
  display:grid;grid-template-columns:56px 1fr;gap:8px;
  padding:7px 0;border-bottom:1px solid hsl(var(--gray-10))}
.copilot--reuniao .cpm-sem-dia:last-child{border-bottom:0}
/* O dia de HOJE ganha faixa, não só borda: numa lista de sete, o contorno
   fino se perde entre as divisórias. */
.copilot--reuniao .cpm-sem-dia--hoje{
  background:hsl(var(--cpm-evento) / .10);
  border-radius:var(--radius-sm,6px);padding-left:6px;padding-right:6px}
.copilot--reuniao .cpm-sem-rotulo{
  display:flex;flex-direction:column;line-height:1.25;padding-top:2px}
.copilot--reuniao .cpm-sem-nome{
  font-size:.625rem;font-weight:600;color:hsl(var(--gray-50));
  text-transform:uppercase;letter-spacing:.02em}
.copilot--reuniao .cpm-sem-num{font-size:1.125rem;font-weight:700;color:hsl(var(--gray-80))}
.copilot--reuniao .cpm-sem-dia--hoje .cpm-sem-num{color:hsl(var(--cpm-evento))}
/* Dia COM reunião: o número já responde "que dias estão ocupados?" antes de
   ler qualquer linha. */
.copilot--reuniao .cpm-sem-dia--cheio .cpm-sem-num{color:hsl(var(--cpm-evento))}
.copilot--reuniao .cpm-sem-dia--cheio .cpm-sem-nome{color:hsl(var(--gray-80))}
.copilot--reuniao .cpm-sem-itens{display:flex;flex-direction:column;gap:4px;min-width:0}
/* A reunião da semana é um chip que respira: o do mês tem 9px de altura
   porque disputa espaço com 41 outras células; aqui só há sete linhas. */
.copilot--reuniao .cpm-sem-item{
  display:flex;align-items:center;gap:7px;min-width:0;
  padding:7px 10px;border-radius:var(--radius-sm,6px);
  border:1px solid hsl(var(--cpm-evento) / .55);
  border-left:4px solid hsl(var(--cpm-evento));
  background:hsl(var(--cpm-evento) / .26);
  color:hsl(var(--gray-80));font-size:.8125rem;cursor:pointer;
  text-align:left;font-family:inherit;
  width:100%;transition:all .1s}
.copilot--reuniao .cpm-sem-item:hover{
  background:hsl(var(--cpm-evento) / .40);
  border-color:hsl(var(--cpm-evento));border-left-width:6px}
.copilot--reuniao .cpm-sem-item svg{flex:0 0 auto;width:15px;height:15px;
  fill:hsl(var(--cpm-evento))}
.copilot--reuniao .cpm-sem-hora{
  font-weight:700;flex:0 0 auto;font-size:.875rem;
  font-variant-numeric:tabular-nums}
.copilot--reuniao .cpm-sem-quem{
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.copilot--reuniao .cpm-sem-vazio{
  font-size:.75rem;color:hsl(var(--gray-50));padding:5px 2px}
/* Horário que o PAINEL diz ocupado e que não veio da extensão. Cinza e sem a
   barra colorida de propósito: é compromisso que existe, mas cujo conteúdo a
   gente não conhece — pintar igual às nossas reuniões prometeria um clique
   que não leva a lugar nenhum. */
.copilot--reuniao .cpm-sem-ocupado{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  font-size:.6875rem;color:hsl(var(--gray-50));padding:3px 2px}
.copilot--reuniao .cpm-sem-ocupado b{
  font-weight:600;color:hsl(var(--gray-50))}
.copilot--reuniao .cpm-sem-hora-ocupada{
  padding:1px 5px;border-radius:3px;background:hsl(var(--gray-10));
  color:hsl(var(--gray-50));font-weight:600}

/* Alternador Mês | Semana, no lugar do que o painel põe no canto direito. */
.copilot--reuniao .cpm-abas{
  display:flex;gap:4px;margin-bottom:.75rem;
  background:hsl(var(--gray-10));padding:3px;border-radius:var(--radius-md)}
.copilot--reuniao .cpm-aba{
  flex:1;padding:6px 0;border:0;border-radius:var(--radius-sm,6px);
  background:transparent;color:hsl(var(--gray-50));cursor:pointer;
  font-family:inherit;font-size:.8125rem;font-weight:600;transition:all .1s}
.copilot--reuniao .cpm-aba:hover{color:hsl(var(--gray-80))}
.copilot--reuniao .cpm-aba--ativa{
  background:hsl(var(--gray-00));color:hsl(var(--gray-80));
  box-shadow:0 1px 2px hsl(var(--gray-80) / .08)}

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

  /**
   * Ícone de 20px no traço, como os do Copiloto.
   *
   * Antes eram os caracteres "‹" e "✕": eles herdam a métrica da fonte, saem
   * pequenos, desalinhados na vertical e com peso diferente do resto da barra —
   * é o que fazia a seta de voltar parecer um erro de digitação. SVG resolve
   * porque o tamanho e a espessura são nossos, e `currentColor` mantém a cor
   * vindo do `.button--empty` deles.
   */
  function icone(caminho, opcoes) {
    const NS = 'http://www.w3.org/2000/svg';
    const preenchido = Boolean(opcoes && opcoes.preenchido);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', (opcoes && opcoes.viewBox) || '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    // `currentColor` nos dois casos, e é o que importa: o arquivo original da
    // seta vinha com `fill="#000000"` cravado, o que a deixaria PRETA no tema
    // escuro — invisível em cima do painel. Assim ela herda a cor do
    // `.button--empty` do chatPro e acompanha a troca de tema.
    if (preenchido) {
      svg.setAttribute('fill', 'currentColor');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', caminho);
    svg.appendChild(p);
    return svg;
  }

  /**
   * Os dois ícones do cabeçalho, da MESMA família (Phosphor, preenchidos).
   *
   * A seta veio do arquivo que o usuário escolheu. O X foi trocado pelo
   * correspondente dela: um ícone de traço ao lado de um preenchido, na mesma
   * barra e no mesmo tamanho, fica com pesos visuais diferentes — é sutil, mas
   * é o tipo de coisa que faz a barra parecer montada de retalhos.
   */
  const SETA_VOLTAR =
    'M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,' +
    '0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z';
  const X_FECHAR =
    'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,' +
    '128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,' +
    '128Z';

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
    voltar.appendChild(icone(SETA_VOLTAR, { preenchido: true, viewBox: '0 0 256 256' }));
    voltar.setAttribute('aria-label', 'Voltar');
    voltar.hidden = true;
    esquerda.appendChild(voltar);

    const titulo = el('h1', '', 'Reunião');

    const fecharBtn = el('button', 'button button--empty button--inv');
    fecharBtn.type = 'button';
    fecharBtn.appendChild(icone(X_FECHAR, { preenchido: true, viewBox: '0 0 256 256' }));
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
        // Mesma troca do calendario: --cool-green-70 sai azulado no chatPro
        // real, e este verde e o do link da reuniao na tela de sucesso.
        verde: 'hsl(var(--cpm-evento))',
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
      /**
       * Alarga a aba pra caber o calendário com nome de cliente.
       *
       * A largura real vem do `.copilot` do chatPro; aqui só entra um
       * modificador que sobrescreve o flex-basis e a margem negativa de
       * fechamento. Devolve o estado pra quem precisa desenhar o botão.
       *
       * A ANIMAÇÃO é de graça: o `.copilot` já traz `transition: all .2s`
       * pra própria abertura, e trocar o flex-basis entra nessa transição.
       * Por isso aqui não há transition própria — declarar uma substituiria
       * o `all` do chatPro e mataria a animação de abrir e fechar a aba.
       *
       * NÃO é chamada por `limpar()`: resetar a cada tela faria a aba
       * encolher e crescer de novo ao entrar na agenda, duas animações
       * seguidas. Quem precisa de estreito pede explicitamente.
       */
      largura(largo) {
        raiz.classList.toggle('cpm-largo', largo === true);
        return raiz.classList.contains('cpm-largo');
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
