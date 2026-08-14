/**
 * HTML do painel (servido em GET /).
 *
 * Autocontido (CSS + JS inline), identidade visual chatPro. O JS monta o DOM
 * com textContent — nunca innerHTML com dado dinâmico. Textos em português.
 *
 * Duas abas:
 *   - "Reuniões (bot)"      → /api/meetings (bot do Recall.ai) — aba padrão
 *   - "Capturas (extensão)" → /api/captures (fluxo antigo, intacto)
 *
 * A aba de reuniões abre com a faixa de supervisão (indicadores dos últimos 7
 * dias, gráfico por dia e busca nas transcrições). Ela consome
 * /api/meetings/resumo-supervisao e /api/meetings/busca; se qualquer uma das
 * duas falhar ou nem existir, a faixa mostra um aviso discreto e o resto da
 * tela continua funcionando.
 *
 * ATENÇÃO: o arquivo inteiro é um template literal. NUNCA usar interpolação
 * (cifrão + chaves) dentro do HTML/JS embutido — o TypeScript interpola e
 * quebra o build. Use concatenação de strings. Barras invertidas precisam ser
 * dobradas (ex.: '\\n').
 */
export function reviewPageHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chatPro — Revisão de transcrições</title>
<style>
  /*
   * Tema escuro é o padrão da identidade chatPro; o claro entra por
   * prefers-color-scheme. Toda cor mora num token justamente pra existir
   * um único lugar onde os dois temas são decididos.
   */
  :root {
    --verde: #25D066; --verde-hover: #1BAD53; --neon: #24FF72;
    --bg: #1d2125; --surface: #22272b; --card: #2c333a;
    --cinza1: #D1D1D5; --cinza2: #E6E5E8; --texto: #F1F0F2;
    --vermelho: #ff6b6b; --azul: #62C6FF; --ambar: #ffc400;

    /* Variantes legíveis como TEXTO (as de cima são de preenchimento). */
    --verde-txt: #25D066; --vermelho-txt: #ff6b6b;
    --azul-txt: #62C6FF; --ambar-txt: #ffc400;
    --laranja-txt: #FFB05E; --roxo-txt: #C9A6FF;

    --borda-forte: #000; --borda-suave: #1a1e22; --fundo-tenue: #1a1e22;
    --borda-campo: #3a424a; --borda-perigo: #5a3336;
    --placeholder: #6b7480; --sobre-verde: #05130a;
    --sombra: rgba(0,0,0,.45);

    --p0: #24FF72; --p1: #62C6FF; --p2: #FFC46B;
    --p3: #FF8FB1; --p4: #C9A6FF; --p5: #7CE7D2;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #F5F7F8; --surface: #FFFFFF; --card: #EDF0F3;
      --cinza1: #5A636E; --cinza2: #3B434C; --texto: #14181C;

      --verde-txt: #0E7A38; --vermelho-txt: #C0392B;
      --azul-txt: #0B6FA4; --ambar-txt: #8A6100;
      --laranja-txt: #9A5200; --roxo-txt: #6A3FBF;

      --borda-forte: #D5DAE0; --borda-suave: #E4E7EB; --fundo-tenue: #E7EBEF;
      --borda-campo: #C2C9D1; --borda-perigo: #E3A9AC;
      --placeholder: #8A929C; --sobre-verde: #05130a;
      --sombra: rgba(20,24,28,.18);

      --p0: #1B7F3B; --p1: #0B6FA4; --p2: #8A5A00;
      --p3: #B03060; --p4: #6A3FBF; --p5: #0E6F63;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--texto);
    font-family: 'Space Grotesk', system-ui, sans-serif;
    height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  header { background: var(--surface); padding: 18px 24px; border-bottom: 1px solid var(--borda-forte);
    display: flex; align-items: baseline; gap: 12px; flex: none; }
  header .logo { font-family: 'Paytone One', system-ui, sans-serif;
    font-weight: 800; font-size: 22px; color: var(--verde-txt); letter-spacing: .3px; }
  header .sub { color: var(--cinza1); font-size: 14px; }

  /* Abas */
  .abas { flex: none; display: flex; gap: 4px; background: var(--surface);
    padding: 0 16px; border-bottom: 1px solid var(--borda-forte); }
  .abas button { background: transparent; border: none; border-bottom: 3px solid transparent;
    color: var(--cinza1); font: inherit; font-weight: 700; font-size: 14px;
    padding: 12px 14px; cursor: pointer; }
  .abas button:hover { color: var(--texto); }
  .abas button[aria-selected="true"] { color: var(--verde-txt); border-bottom-color: var(--verde); }
  .painel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .painel.oculto { display: none; }

  .wrap { display: grid; grid-template-columns: 320px 1fr; gap: 0; flex: 1; min-height: 0; }
  .list { border-right: 1px solid var(--borda-forte); overflow-y: auto; background: var(--surface); }
  .item { padding: 14px 18px; border-bottom: 1px solid var(--borda-suave); cursor: pointer; }
  .item:hover { background: var(--card); }
  .item.sel { background: var(--card); border-left: 3px solid var(--verde); }
  .item .code { font-weight: 700; color: var(--texto); }
  #lista-reunioes .code { word-break: break-word; }
  .item .meta { font-size: 12px; color: var(--cinza1); margin-top: 4px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 700; }
  .badge.ok { background: rgba(37,208,102,.15); color: var(--verde-txt); }
  .badge.warn { background: rgba(255,196,0,.18); color: var(--ambar-txt); }
  .badge.mut { background: var(--fundo-tenue); color: var(--cinza1); }
  .badge.info { background: rgba(98,198,255,.18); color: var(--azul-txt); }
  .badge.err { background: rgba(255,107,107,.18); color: var(--vermelho-txt); }
  /* Tipos do fluxo comercial: cada tipo tem uma cor fixa, legível nos dois temas. */
  .badge.tipo-apresentacao { background: rgba(98,198,255,.18); color: var(--azul-txt); }
  .badge.tipo-migracao { background: rgba(255,159,67,.18); color: var(--laranja-txt); }
  .badge.tipo-implantacao { background: rgba(178,132,255,.18); color: var(--roxo-txt); }
  .badge.tipo-cs { background: rgba(37,208,102,.15); color: var(--verde-txt); }
  .badge.rec { background: rgba(255,107,107,.18); color: var(--vermelho-txt);
    animation: pulsa 1.4s ease-in-out infinite; }
  @keyframes pulsa { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .badge.rec { animation: none; } }
  .detail { overflow-y: auto; padding: 24px 28px; }
  .empty { color: var(--cinza1); margin-top: 40px; text-align: center; }
  .cov { margin: 8px 0 18px; }
  .bar { height: 8px; background: var(--fundo-tenue); border-radius: 999px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--verde); }
  .gap { color: var(--ambar-txt); font-size: 13px; margin: 3px 0; }
  .players { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0 20px; }
  .players div { font-size: 12px; color: var(--cinza1); }
  audio { display: block; margin-top: 4px; }
  .line { display: grid; grid-template-columns: 96px 1fr; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid var(--borda-suave); }
  /* A coluna de quem falou é mais larga nas reuniões: nome real + "anfitrião". */
  .line.reuniao { grid-template-columns: 118px 1fr; }
  .line.reuniao .who { word-break: break-word; }
  .line.reuniao .t { font-weight: 400; }
  .who { font-weight: 700; font-size: 13px; }
  .who.at { color: var(--verde-txt); }
  .who.cl { color: var(--p0); }
  .who.ot { color: var(--cinza1); }
  .t { font-size: 12px; color: var(--cinza1); }
  .txt { line-height: 1.5; }
  .btn { background: var(--verde); color: var(--sobre-verde); border: none; padding: 11px 20px;
    border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .btn:hover { background: var(--verde-hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.ghost { background: transparent; color: var(--cinza1); border: 1px solid var(--borda-campo); }
  .btn.ghost:hover { background: var(--card); color: var(--texto); }
  .btn.perigo { background: transparent; color: var(--vermelho-txt); border: 1px solid var(--borda-perigo); }
  .btn.perigo:hover { background: rgba(255,107,107,.12); color: var(--vermelho-txt); }
  .actions { margin: 18px 0 8px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .note { font-size: 12px; color: var(--cinza1); }
  h2 { margin: 0 0 4px; word-break: break-word; }

  /* Formulário de convocação do bot */
  .forma { flex: none; background: var(--surface); border-bottom: 1px solid var(--borda-forte);
    padding: 16px 20px; }
  .forma .linha { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .forma input { background: var(--bg); border: 1px solid var(--borda-campo); border-radius: 8px;
    color: var(--texto); font: inherit; font-size: 14px; padding: 10px 12px; }
  .forma input::placeholder { color: var(--placeholder); }
  .forma input:focus { outline: none; border-color: var(--verde);
    box-shadow: 0 0 0 2px rgba(37,208,102,.25); }
  .forma input.url { flex: 2 1 300px; }
  .forma input.sessao { flex: 1 1 220px; }
  .aviso { font-size: 12px; color: var(--cinza1); margin-top: 8px; }
  .msg { font-size: 13px; margin-top: 10px; }
  .msg.ok { color: var(--verde-txt); }
  .msg.erro { color: var(--vermelho-txt); }

  /* Participantes e cores estáveis por pessoa */
  .parts { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 2px; }
  .chip { background: var(--card); border-radius: 999px; padding: 5px 12px;
    font-size: 12px; font-weight: 700; }
  .chip .host, .who .host { color: var(--cinza1); font-weight: 400; font-size: 11px; }
  .chip .host { margin-left: 6px; }
  .p0 { color: var(--p0); }
  .p1 { color: var(--p1); }
  .p2 { color: var(--p2); }
  .p3 { color: var(--p3); }
  .p4 { color: var(--p4); }
  .p5 { color: var(--p5); }
  .anfitriao { box-shadow: inset 2px 0 0 var(--verde); padding-left: 8px; }

  /* Palavras-chave detectadas: chips só de leitura (filtro visual, não botão). */
  .palavras { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0 2px; }
  .palavras .lupa { font-size: 13px; }
  .palavra { background: var(--fundo-tenue); border: 1px solid var(--borda-campo);
    border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700;
    color: var(--verde-txt); }

  /* ─── Supervisão: indicadores, gráfico por dia e busca ─── */
  .super { flex: none; background: var(--bg); border-bottom: 1px solid var(--borda-forte);
    padding: 14px 20px 16px; }
  .super-cab { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .super-cab h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .5px;
    text-transform: uppercase; color: var(--cinza1); }
  .btn-min { background: transparent; border: none; color: var(--cinza1); font: inherit;
    font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
  .btn-min:hover { background: var(--card); color: var(--texto); }
  .super-corpo { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px;
    align-items: start; margin-top: 12px; }
  .super-corpo.oculto { display: none; }
  .super-aviso { font-size: 12px; color: var(--cinza1); margin: 0; }
  /* O filtro fica no cabeçalho da faixa: continua à mão mesmo com ela recolhida. */
  .filtro-tipo { background: var(--surface); border: 1px solid var(--borda-campo);
    border-radius: 8px; color: var(--texto); font: inherit; font-size: 12px;
    font-weight: 700; padding: 4px 8px; cursor: pointer; }
  .filtro-tipo:focus { outline: none; border-color: var(--verde);
    box-shadow: 0 0 0 2px rgba(37,208,102,.25); }

  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .kpi { background: var(--card); border: 1px solid transparent; border-radius: 10px;
    padding: 9px 12px; }
  .kpi .n { font-size: 24px; font-weight: 800; line-height: 1.1; }
  .kpi .r { font-size: 11px; color: var(--cinza1); margin-top: 2px; line-height: 1.3; }
  .kpi.bom .n { color: var(--verde-txt); }
  .kpi.atencao .n { color: var(--ambar-txt); }
  /* Reunião sem gravação é o buraco que a ferramenta existe pra fechar: grita. */
  .kpi.destaque { border-color: var(--vermelho-txt); background: rgba(255,107,107,.12); }
  .kpi.destaque .n { color: var(--vermelho-txt); }
  .kpi.destaque .r { color: var(--vermelho-txt); font-weight: 700; }
  #por-atendente { margin-top: 8px; }

  .grafico { margin-top: 10px; }
  .grafico svg { display: block; width: 100%; height: 132px; }
  .g-ok { fill: var(--verde); }
  .g-falta { fill: var(--vermelho); }
  .g-vazio { fill: var(--fundo-tenue); }
  .g-eixo { stroke: var(--borda-suave); stroke-width: 1; }
  .g-rot { fill: var(--cinza1); font-size: 10px; font-family: inherit; }
  .g-num { font-weight: 700; }
  .g-legenda { display: flex; gap: 16px; margin-top: 2px; font-size: 11px; color: var(--cinza1); }
  .g-legenda .pt { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
    margin-right: 5px; }
  .g-legenda .pt.ok { background: var(--verde); }
  .g-legenda .pt.falta { background: var(--vermelho); }

  .busca { position: relative; }
  .busca-rot { display: block; font-size: 12px; font-weight: 700; letter-spacing: .5px;
    text-transform: uppercase; color: var(--cinza1); margin-bottom: 6px; }
  .busca input { width: 100%; background: var(--surface); border: 1px solid var(--borda-campo);
    border-radius: 8px; color: var(--texto); font: inherit; font-size: 14px; padding: 10px 12px; }
  .busca input::placeholder { color: var(--placeholder); }
  .busca input:focus { outline: none; border-color: var(--verde);
    box-shadow: 0 0 0 2px rgba(37,208,102,.25); }
  .busca-status { font-size: 11px; color: var(--cinza1); margin-top: 6px; min-height: 14px; }
  .resultados { position: absolute; z-index: 30; top: 100%; left: 0; right: 0;
    max-height: 320px; overflow-y: auto; background: var(--surface);
    border: 1px solid var(--borda-campo); border-radius: 10px;
    box-shadow: 0 14px 30px var(--sombra); }
  .resultados.oculto { display: none; }
  .res { display: block; width: 100%; text-align: left; background: transparent; border: none;
    border-bottom: 1px solid var(--borda-suave); color: var(--texto); font: inherit;
    padding: 10px 12px; cursor: pointer; }
  .res:last-child { border-bottom: none; }
  .res:hover, .res:focus { background: var(--card); outline: none; }
  .res .rc { font-size: 12px; font-weight: 700; color: var(--verde-txt); word-break: break-word; }
  .res .rq { font-size: 11px; color: var(--cinza1); margin-top: 1px; word-break: break-word; }
  .res .rt { font-size: 13px; line-height: 1.4; margin-top: 4px; }
  .realce { background: rgba(37,208,102,.30); color: inherit; border-radius: 3px; padding: 0 2px; }

  /* Tela baixa: a faixa não pode espremer a lista de reuniões a zero. */
  @media (max-height: 760px) {
    .grafico svg { height: 96px; }
    .kpi .n { font-size: 19px; }
  }

  @media (max-width: 860px) {
    body { height: auto; overflow: auto; }
    header { flex-wrap: wrap; gap: 4px; }
    .wrap { grid-template-columns: 1fr; }
    .list { border-right: none; border-bottom: 1px solid var(--borda-forte); max-height: 42vh; }
    .detail { padding: 18px 16px; }
    .line { grid-template-columns: 1fr; gap: 2px; }
    .super { padding: 12px 16px 14px; }
    .super-corpo { grid-template-columns: 1fr; gap: 14px; }
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
</head>
<body>
<header>
  <span class="logo">chatPro</span>
  <span class="sub">Transcrições de reunião — confira antes de enviar</span>
</header>

<nav class="abas" role="tablist" aria-label="Seções do painel">
  <button id="aba-reunioes" role="tab" aria-selected="true" aria-controls="painel-reunioes"
    type="button">Reuniões (bot)</button>
  <button id="aba-capturas" role="tab" aria-selected="false" aria-controls="painel-capturas"
    type="button">Capturas (extensão)</button>
</nav>

<section id="painel-reunioes" class="painel" role="tabpanel" aria-labelledby="aba-reunioes">
  <div class="super">
    <div class="super-cab">
      <h3>Supervisão — últimos 7 dias</h3>
      <button id="super-toggle" class="btn-min" type="button"
        aria-controls="super-corpo" aria-expanded="true">ocultar</button>
      <select id="filtro-tipo" class="filtro-tipo"
        aria-label="Filtrar a lista de reuniões por tipo">
        <option value="">Todos os tipos</option>
        <option value="apresentacao">Apresentação</option>
        <option value="migracao">Migração</option>
        <option value="implantacao">Implantação</option>
        <option value="cs">CS</option>
      </select>
      <span id="super-aviso" class="super-aviso" role="status" aria-live="polite"></span>
    </div>
    <div id="super-corpo" class="super-corpo">
      <div>
        <div id="kpis" class="kpis"></div>
        <p id="por-atendente" class="super-aviso"></p>
        <div id="grafico" class="grafico"></div>
      </div>
      <div class="busca">
        <label class="busca-rot" for="busca-campo">Buscar nas transcrições</label>
        <input id="busca-campo" type="search" autocomplete="off" spellcheck="false"
          placeholder="palavra, nome, código do Meet…">
        <div id="busca-status" class="busca-status" role="status" aria-live="polite"></div>
        <div id="busca-resultados" class="resultados oculto"
          aria-label="Resultados da busca"></div>
      </div>
    </div>
  </div>
  <div class="forma">
    <div class="linha">
      <input id="meet-url" class="url" type="text" autocomplete="off" spellcheck="false"
        placeholder="https://meet.google.com/abc-defg-hij" aria-label="URL da reunião do Meet">
      <input id="meet-sessao" class="sessao" type="text" autocomplete="off" spellcheck="false"
        placeholder="sessão chatPro (uuid) — opcional" aria-label="Sessão do chatPro (opcional)">
      <button id="btn-criar" class="btn" type="button">Enviar bot pra reunião</button>
    </div>
    <div class="aviso">Alguém precisa admitir o bot na sala de espera.</div>
    <div id="form-msg" class="msg" role="status" aria-live="polite"></div>
  </div>
  <div class="wrap">
    <div class="list" id="lista-reunioes"></div>
    <div class="detail" id="detalhe-reuniao">
      <p class="empty">Selecione uma reunião à esquerda.</p>
    </div>
  </div>
</section>

<section id="painel-capturas" class="painel oculto" role="tabpanel" aria-labelledby="aba-capturas">
  <div class="wrap">
    <div class="list" id="list"></div>
    <div class="detail" id="detail"><p class="empty">Selecione uma captura à esquerda.</p></div>
  </div>
</section>

<script>
(() => {
  'use strict';

  // ─── Utilitários comuns ───────────────────────────────────────────────────

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('pt-BR');
  }
  function fmtMs(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtDuracao(segundos) {
    const s = Math.round(Number(segundos));
    if (!isFinite(s) || s <= 0) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'min';
    if (m > 0) return m + 'min ' + (s % 60) + 's';
    return s + 's';
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ─── Abas ─────────────────────────────────────────────────────────────────

  const abas = [
    {
      nome: 'reunioes',
      botao: document.getElementById('aba-reunioes'),
      painel: document.getElementById('painel-reunioes'),
    },
    {
      nome: 'capturas',
      botao: document.getElementById('aba-capturas'),
      painel: document.getElementById('painel-capturas'),
    },
  ];
  let abaAtiva = 'reunioes';

  function ativarAba(nome) {
    abaAtiva = nome === 'capturas' ? 'capturas' : 'reunioes';
    for (const aba of abas) {
      const ligada = aba.nome === abaAtiva;
      aba.botao.setAttribute('aria-selected', ligada ? 'true' : 'false');
      aba.painel.classList.toggle('oculto', !ligada);
    }
    if (location.hash !== '#' + abaAtiva) location.hash = '#' + abaAtiva;
    atualizarAbaAtiva();
  }
  function atualizarAbaAtiva() {
    if (abaAtiva === 'capturas') {
      loadList();
      return;
    }
    carregarReunioes();
    carregarResumo(false);
  }
  for (const aba of abas) {
    aba.botao.addEventListener('click', () => ativarAba(aba.nome));
  }
  window.addEventListener('hashchange', () => {
    const alvo = location.hash === '#capturas' ? 'capturas' : 'reunioes';
    if (alvo !== abaAtiva) ativarAba(alvo);
  });

  // ─── Aba "Capturas (extensão)" — fluxo antigo ─────────────────────────────

  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  let selected = null;

  function statusBadge(status) {
    const map = { 'ready-for-review': 'ok', 'sent': 'ok', 'failed': 'warn' };
    const b = el('span', 'badge ' + (map[status] || 'mut'), status || '—');
    return b;
  }

  async function loadList() {
    let data;
    try {
      const res = await fetch('/api/captures');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (_) {
      if (!listEl.childNodes.length) {
        listEl.replaceChildren(el('p', 'empty', 'Não foi possível carregar as capturas.'));
      }
      return;
    }
    const capturas = (data && data.captures) || [];
    listEl.replaceChildren();
    if (!capturas.length) {
      listEl.appendChild(el('p', 'empty', 'Nenhuma captura ainda. Entre num Meet com a extensão ativa.'));
      return;
    }
    for (const c of capturas) {
      const item = el('div', 'item' + (c.id === selected ? ' sel' : ''));
      item.appendChild(el('div', 'code', c.meetingCode || '(sem código)'));
      const meta = el('div', 'meta');
      meta.appendChild(statusBadge(c.status));
      meta.appendChild(document.createTextNode(' ' + fmtTime(c.startedAt)));
      item.appendChild(meta);
      item.addEventListener('click', () => selectCapture(c.id));
      listEl.appendChild(item);
    }
  }

  async function selectCapture(id) {
    selected = id;
    await loadList();
    const res = await fetch('/api/captures/' + id).catch(() => null);
    if (!res || !res.ok) { detailEl.replaceChildren(el('p', 'empty', 'Falha ao carregar.')); return; }
    const c = await res.json();
    render(c);
  }

  // Cores estáveis por participante (a legenda traz nomes reais, não só
  // "Atendente"/"Cliente"), pra bater o olho e saber quem falou.
  const coresPorNome = new Map();
  function whoClass(speaker) {
    if (speaker === 'Atendente' || speaker === 'Você') return 'who at';
    if (speaker === 'Cliente') return 'who cl';
    if (!coresPorNome.has(speaker)) {
      coresPorNome.set(speaker, coresPorNome.size % 2 === 0 ? 'who cl' : 'who ot');
    }
    return coresPorNome.get(speaker);
  }

  function render(c) {
    detailEl.replaceChildren();
    detailEl.appendChild(el('h2', null, c.meetingCode || '(sem código)'));
    const info = el('p', 'note',
      'Início ' + fmtTime(c.startedAt) + ' · Fim ' + fmtTime(c.endedAt) +
      ' · STT: ' + (c.sttProvider || '—') + ' · sessão chatPro: ' + (c.sessionId || '—'));
    detailEl.appendChild(info);

    // Cobertura
    const cov = el('div', 'cov');
    const pct = Math.round((c.coverageRatio || 0) * 100);
    cov.appendChild(el('div', 'note', 'Cobertura da captura: ' + pct + '%'));
    const bar = el('div', 'bar'); const fill = el('div'); fill.style.width = pct + '%';
    bar.appendChild(fill); cov.appendChild(bar);
    for (const g of (c.gaps || [])) {
      const motivo = g.reason === 'capturing-off-in-call'
        ? 'captura interrompida durante a chamada' : 'sem sinal';
      cov.appendChild(el('div', 'gap', '⚠ Buraco ' + fmtMs(g.fromMs) + '–' + fmtMs(g.toMs) + ' (' + motivo + ')'));
    }
    detailEl.appendChild(cov);

    // Áudio
    const players = el('div', 'players');
    for (const track of ['mic', 'remote']) {
      if (c.hasAudio && c.hasAudio[track]) {
        const box = el('div', null);
        box.appendChild(document.createTextNode(track === 'mic' ? 'Atendente (microfone)' : 'Cliente (remoto)'));
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = '/api/captures/' + c.id + '/audio/' + track;
        box.appendChild(audio);
        players.appendChild(box);
      }
    }
    if (players.childNodes.length) detailEl.appendChild(players);

    // Ações
    const actions = el('div', 'actions');
    const btn = el('button', 'btn', c.voreoStatus === 'sent' ? 'Enviado à Voreo ✓' : 'Enviar pra Voreo');
    btn.disabled = c.voreoStatus === 'sent';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Enviando…';
      const r = await fetch('/api/captures/' + c.id + '/send-voreo', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      btn.textContent = data.status === 'sent' ? 'Enviado à Voreo ✓'
        : (data.status === 'skipped-no-url' ? 'Voreo não configurada' : 'Falhou — tentar de novo');
      btn.disabled = data.status === 'sent';
      selectCapture(c.id);
    });
    actions.appendChild(btn);

    // Reprocessar (útil se a transcrição travou ou o modelo ainda baixava).
    const reBtn = el('button', 'btn ghost', 'Transcrever de novo');
    reBtn.addEventListener('click', async () => {
      reBtn.disabled = true; reBtn.textContent = 'Reenfileirado…';
      await fetch('/api/captures/' + c.id + '/reprocess', { method: 'POST' });
      setTimeout(() => selectCapture(c.id), 800);
    });
    actions.appendChild(reBtn);
    if (c.voreoStatus && c.voreoStatus !== 'sent') {
      actions.appendChild(el('span', 'note', 'Status: ' + c.voreoStatus));
    }
    detailEl.appendChild(actions);

    // Transcrição
    if (!c.transcript.length) {
      detailEl.appendChild(el('p', 'note',
        c.sttProvider === 'none'
          ? 'Sem STT configurado — configure STT_API_KEY pra ver o texto. O áudio acima já confirma que a captura funcionou.'
          : 'Transcrição vazia (nenhuma fala detectada).'));
      return;
    }

    // Quem falou (nomes reais quando vêm da legenda do Meet).
    const nomes = [...new Set(c.transcript.map(l => l.speaker))];
    const resumo = el('p', 'note',
      c.transcript.length + ' falas · participantes: ' + nomes.join(', '));
    detailEl.appendChild(resumo);

    // Copiar tudo
    const barra = el('div', 'actions');
    const btnCopiar = el('button', 'btn ghost', 'Copiar transcrição');
    btnCopiar.addEventListener('click', async () => {
      const texto = c.transcript
        .map(l => '[' + fmtMs(l.startMs) + '] ' + l.speaker + ': ' + l.text)
        .join('\\n');
      try {
        await navigator.clipboard.writeText(texto);
        btnCopiar.textContent = 'Copiado ✓';
        setTimeout(() => { btnCopiar.textContent = 'Copiar transcrição'; }, 2000);
      } catch (_) {
        btnCopiar.textContent = 'Não foi possível copiar';
      }
    });
    barra.appendChild(btnCopiar);
    detailEl.appendChild(barra);

    // Paginação: reuniões longas não travam a página.
    const POR_PAGINA = 150;
    const totalPaginas = Math.ceil(c.transcript.length / POR_PAGINA);
    let pagina = 0;
    const lista = el('div', null);
    const nav = el('div', 'actions');
    detailEl.appendChild(lista);
    if (totalPaginas > 1) detailEl.appendChild(nav);

    function desenharPagina() {
      lista.replaceChildren();
      const ini = pagina * POR_PAGINA;
      for (const line of c.transcript.slice(ini, ini + POR_PAGINA)) {
        const row = el('div', 'line');
        const who = el('div', whoClass(line.speaker));
        who.appendChild(el('div', null, line.speaker));
        who.appendChild(el('div', 't', fmtMs(line.startMs)));
        row.appendChild(who);
        row.appendChild(el('div', 'txt', line.text));
        lista.appendChild(row);
      }
      if (totalPaginas > 1) {
        nav.replaceChildren();
        const ant = el('button', 'btn ghost', '← Anteriores');
        ant.disabled = pagina === 0;
        ant.addEventListener('click', () => { pagina--; desenharPagina(); lista.scrollIntoView(); });
        const prox = el('button', 'btn ghost', 'Próximas →');
        prox.disabled = pagina >= totalPaginas - 1;
        prox.addEventListener('click', () => { pagina++; desenharPagina(); lista.scrollIntoView(); });
        nav.appendChild(ant);
        nav.appendChild(el('span', 'note', 'Página ' + (pagina + 1) + ' de ' + totalPaginas));
        nav.appendChild(prox);
      }
    }
    desenharPagina();
  }

  // ─── Aba "Reuniões (bot)" — Recall.ai ─────────────────────────────────────

  const urlEl = document.getElementById('meet-url');
  const sessaoEl = document.getElementById('meet-sessao');
  const btnCriarEl = document.getElementById('btn-criar');
  const msgEl = document.getElementById('form-msg');
  const listaReuEl = document.getElementById('lista-reunioes');
  const detalheReuEl = document.getElementById('detalhe-reuniao');

  const POR_PAGINA_REUNIAO = 150;
  const PREFIXO_MEET = 'https://meet.google.com/';

  const ROTULO_STATUS = new Map([
    ['created', 'Criada'],
    ['joining', 'Entrando'],
    ['waiting_room', 'Na sala de espera'],
    ['recording', 'Gravando'],
    ['ended', 'Encerrada'],
    ['done', 'Pronta'],
    ['failed', 'Falhou'],
  ]);
  const CLASSE_STATUS = new Map([
    ['created', 'mut'],
    ['joining', 'info'],
    ['waiting_room', 'warn'],
    ['recording', 'rec'],
    ['ended', 'mut'],
    ['done', 'ok'],
    ['failed', 'err'],
  ]);
  const ROTULO_CHATPRO = new Map([
    ['pending', 'Pendente'],
    ['sent', 'Enviado ao chatPro ✓'],
    ['failed', 'Falhou'],
    ['skipped-no-url', 'chatPro não configurado'],
  ]);
  // Tipos do fluxo comercial. Reunião antiga (sem tipo) segue na lista sem badge.
  const ROTULO_TIPO = new Map([
    ['apresentacao', 'Apresentação'],
    ['migracao', 'Migração'],
    ['implantacao', 'Implantação'],
    ['cs', 'CS'],
  ]);

  let reunioes = [];
  let reunioesCarregadas = false;
  let reuniaoSel = null;
  let assinaturaRenderizada = '';
  // Filtro por tipo escolhido na faixa de supervisão. Só refaz o desenho da
  // lista: os dados já estão em memória, não faz sentido voltar ao servidor.
  let filtroTipo = '';

  // O contrato de /api/meetings é criado em paralelo: aceitar tanto camelCase
  // quanto snake_case (e envelope ou objeto cru) evita a página quebrar por
  // uma diferença de nome de campo.
  function campo(obj, camel, snake) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[camel] !== undefined && obj[camel] !== null) return obj[camel];
    if (obj[snake] !== undefined && obj[snake] !== null) return obj[snake];
    return null;
  }
  function listaDe(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.meetings)) return data.meetings;
    if (data && Array.isArray(data.reunioes)) return data.reunioes;
    return [];
  }
  function objetoDe(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.meeting && typeof data.meeting === 'object') return data.meeting;
    if (data.reuniao && typeof data.reuniao === 'object') return data.reuniao;
    return data;
  }
  function numero(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function textoOuVazio(v) {
    return typeof v === 'string' ? v : '';
  }

  /** Código do Meet: usa o do servidor e, na falta, o último trecho da URL. */
  function codigoDaReuniao(m) {
    const codigo = textoOuVazio(campo(m, 'meetingCode', 'meeting_code')).trim();
    if (codigo) return codigo;
    const url = textoOuVazio(campo(m, 'meetingUrl', 'meeting_url'));
    if (!url) return '(sem código)';
    const semQuery = url.split('?')[0].split('#')[0];
    const partes = semQuery.split('/').filter((p) => p !== '');
    const ultimo = partes.length ? partes[partes.length - 1] : '';
    return ultimo || url;
  }

  function statusDaReuniao(m) {
    return textoOuVazio(m && m.status);
  }
  function badgeReuniao(status) {
    const classe = CLASSE_STATUS.get(status) || 'mut';
    const rotulo = ROTULO_STATUS.get(status) || (status || '—');
    return el('span', 'badge ' + classe, rotulo);
  }

  /** Valor desconhecido vira vazio: melhor sem badge do que badge errada. */
  function tipoDaReuniao(m) {
    const t = textoOuVazio(m && m.tipo).trim().toLowerCase();
    return ROTULO_TIPO.has(t) ? t : '';
  }
  function badgeTipo(tipo) {
    return el('span', 'badge tipo-' + tipo, ROTULO_TIPO.get(tipo));
  }
  /** Quem marcou a reunião. O contrato ainda está sendo ligado: pode faltar. */
  function atendenteDe(m) {
    return textoOuVazio(campo(m, 'atendenteEmail', 'atendente_email')).trim();
  }
  /** Na lista só cabe o prefixo do e-mail (antes do @); o inteiro fica no detalhe. */
  function prefixoEmail(email) {
    const arroba = email.indexOf('@');
    return arroba > 0 ? email.slice(0, arroba) : email;
  }
  /** Palavras-chave detectadas pela análise; qualquer coisa fora de string[] vira []. */
  function palavrasDe(m) {
    const bruto = m ? m.palavras : null;
    if (!Array.isArray(bruto)) return [];
    const saida = [];
    for (const p of bruto) {
      if (typeof p === 'string' && p.trim() !== '') saida.push(p.trim());
    }
    return saida;
  }

  /** Aceita transcript como array de falas ou como objeto normalizado. */
  function falasDe(m) {
    const t = m ? m.transcript : null;
    let bruto = null;
    if (Array.isArray(t)) bruto = t;
    else if (t && typeof t === 'object' && Array.isArray(t.falas)) bruto = t.falas;
    else if (t && typeof t === 'object' && Array.isArray(t.lines)) bruto = t.lines;
    else if (m && Array.isArray(m.falas)) bruto = m.falas;
    if (!bruto) return [];
    return bruto.map((f) => {
      if (!f || typeof f !== 'object') {
        return { speaker: '—', text: String(f == null ? '' : f), startMs: 0, endMs: 0, isHost: false };
      }
      return {
        speaker: textoOuVazio(f.speaker || f.nome || f.name) || '—',
        text: textoOuVazio(f.text || f.texto),
        startMs: numero(campo(f, 'startMs', 'start_ms')),
        endMs: numero(campo(f, 'endMs', 'end_ms')),
        isHost: f.isHost === true || f.is_host === true,
      };
    });
  }

  function participantesDe(m, falas) {
    const t = m ? m.transcript : null;
    const doTranscript = t && typeof t === 'object' && !Array.isArray(t)
      ? (t.participantes || t.participants) : null;
    const bruto = m.participants || m.participantes || doTranscript;
    const saida = [];
    const vistos = new Set();
    if (Array.isArray(bruto)) {
      for (const p of bruto) {
        const nome = typeof p === 'string' ? p : textoOuVazio(p && (p.nome || p.name));
        if (!nome || vistos.has(nome)) continue;
        vistos.add(nome);
        saida.push({
          nome: nome,
          isHost: !!(p && (p.isHost === true || p.is_host === true)),
          email: (p && typeof p.email === 'string') ? p.email : null,
        });
      }
    }
    if (!saida.length) {
      for (const f of falas) {
        if (!f.speaker || vistos.has(f.speaker)) continue;
        vistos.add(f.speaker);
        saida.push({ nome: f.speaker, isHost: f.isHost === true, email: null });
      }
    }
    return saida;
  }

  function assinaturaDe(m) {
    // Palavras e tipo entram na assinatura: a análise chega DEPOIS da reunião
    // e o detalhe aberto precisa ganhar os chips sem o supervisor recarregar.
    return statusDaReuniao(m) + '|' +
      textoOuVazio(campo(m, 'chatproStatus', 'chatpro_status')) + '|' +
      numero(campo(m, 'durationSeconds', 'duration_seconds')) + '|' +
      tipoDaReuniao(m) + '|' + palavrasDe(m).length;
  }

  // ── Lista ──

  async function carregarReunioes() {
    let data;
    try {
      const res = await fetch('/api/meetings');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (_) {
      if (!reunioesCarregadas) {
        listaReuEl.replaceChildren(
          el('p', 'empty', 'Não foi possível carregar as reuniões. Tentando de novo em instantes.'));
      }
      return;
    }
    reunioes = listaDe(data);
    reunioesCarregadas = true;
    desenharListaReunioes();
    conferirDetalhe();
  }

  function desenharListaReunioes() {
    listaReuEl.replaceChildren();
    if (!reunioes.length) {
      listaReuEl.appendChild(
        el('p', 'empty', 'Nenhuma reunião ainda. Cole a URL de um Meet acima.'));
      return;
    }
    const visiveis = filtroTipo
      ? reunioes.filter((m) => tipoDaReuniao(m) === filtroTipo)
      : reunioes;
    if (!visiveis.length) {
      // Mensagem distinta da lista vazia: existem reuniões, o filtro que escondeu.
      listaReuEl.appendChild(el('p', 'empty',
        'Nenhuma reunião do tipo "' + (ROTULO_TIPO.get(filtroTipo) || filtroTipo) + '".'));
      return;
    }
    for (const m of visiveis) {
      const id = textoOuVazio(m && m.id);
      const item = el('div', 'item' + (id && id === reuniaoSel ? ' sel' : ''));
      item.appendChild(el('div', 'code', codigoDaReuniao(m)));
      const meta = el('div', 'meta');
      meta.appendChild(badgeReuniao(statusDaReuniao(m)));
      const tipo = tipoDaReuniao(m);
      if (tipo) {
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(badgeTipo(tipo));
      }
      const quando = campo(m, 'createdAt', 'created_at') || campo(m, 'startedAt', 'started_at');
      const atendente = atendenteDe(m);
      meta.appendChild(document.createTextNode(' ' + fmtTime(quando) +
        (atendente ? ' · ' + prefixoEmail(atendente) : '')));
      item.appendChild(meta);
      if (id) item.addEventListener('click', () => selecionarReuniao(id));
      listaReuEl.appendChild(item);
    }
  }

  // O filtro mora na faixa de supervisão, mas mexe só nesta lista, localmente.
  const filtroTipoEl = document.getElementById('filtro-tipo');
  filtroTipoEl.addEventListener('change', () => {
    filtroTipo = textoOuVazio(filtroTipoEl.value);
    desenharListaReunioes();
  });

  /**
   * O status muda sozinho (webhook do Recall). A cada atualização da lista,
   * redesenha o detalhe SÓ se algo relevante mudou — assim a paginação e a
   * posição de leitura não se perdem a cada 10 segundos.
   */
  function conferirDetalhe() {
    if (!reuniaoSel) return;
    const atual = reunioes.find((m) => m && m.id === reuniaoSel);
    if (!atual) return;
    if (assinaturaDe(atual) !== assinaturaRenderizada) selecionarReuniao(reuniaoSel);
  }

  async function selecionarReuniao(id) {
    reuniaoSel = id;
    desenharListaReunioes();
    let m;
    try {
      const res = await fetch('/api/meetings/' + encodeURIComponent(id));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      m = objetoDe(await res.json());
    } catch (_) {
      assinaturaRenderizada = '';
      detalheReuEl.replaceChildren(el('p', 'empty', 'Não foi possível carregar a reunião.'));
      return;
    }
    if (!m) {
      assinaturaRenderizada = '';
      detalheReuEl.replaceChildren(el('p', 'empty', 'Não foi possível carregar a reunião.'));
      return;
    }
    renderReuniao(m);
  }

  // ── Detalhe ──

  function renderReuniao(m) {
    assinaturaRenderizada = assinaturaDe(m);
    const status = statusDaReuniao(m);
    const falas = falasDe(m);
    const participantes = participantesDe(m, falas);

    // Cor estável por pessoa dentro desta reunião (ordem de aparição).
    const cores = new Map();
    for (const p of participantes) {
      if (!cores.has(p.nome)) cores.set(p.nome, 'p' + (cores.size % 6));
    }
    const corDe = (nome) => {
      if (!cores.has(nome)) cores.set(nome, 'p' + (cores.size % 6));
      return cores.get(nome);
    };
    const ehAnfitriao = new Set(participantes.filter((p) => p.isHost).map((p) => p.nome));

    detalheReuEl.replaceChildren();

    const cabecalho = el('h2', null, codigoDaReuniao(m));
    detalheReuEl.appendChild(cabecalho);

    const linhaStatus = el('p', 'note');
    linhaStatus.appendChild(badgeReuniao(status));
    const tipo = tipoDaReuniao(m);
    if (tipo) {
      linhaStatus.appendChild(document.createTextNode(' '));
      linhaStatus.appendChild(badgeTipo(tipo));
    }
    linhaStatus.appendChild(document.createTextNode(
      ' ' + textoOuVazio(campo(m, 'meetingUrl', 'meeting_url'))));
    detalheReuEl.appendChild(linhaStatus);

    const duracao = campo(m, 'durationSeconds', 'duration_seconds');
    const duracaoFinal = duracao !== null
      ? duracao
      : (falas.length ? Math.round(falas[falas.length - 1].endMs / 1000) : 0);
    detalheReuEl.appendChild(el('p', 'note',
      'Criada ' + fmtTime(campo(m, 'createdAt', 'created_at')) +
      ' · Início ' + fmtTime(campo(m, 'startedAt', 'started_at')) +
      ' · Fim ' + fmtTime(campo(m, 'endedAt', 'ended_at')) +
      ' · Duração ' + fmtDuracao(duracaoFinal) +
      ' · sessão chatPro: ' + (textoOuVazio(campo(m, 'sessionId', 'session_id')) || '—')));

    // Quem marcou responde pela reunião perante o time: e-mail inteiro aqui.
    const atendente = atendenteDe(m);
    if (atendente) {
      detalheReuEl.appendChild(el('p', 'note', 'Marcada por / Responsável: ' + atendente));
    }

    // Palavras-chave da análise: filtro visual pro supervisor bater o olho —
    // não é botão, clicar não faz nada de propósito.
    const palavras = palavrasDe(m);
    if (palavras.length) {
      const faixaPalavras = el('div', 'palavras');
      faixaPalavras.appendChild(el('span', 'lupa', '🔎'));
      for (const p of palavras) faixaPalavras.appendChild(el('span', 'palavra', p));
      detalheReuEl.appendChild(faixaPalavras);
    }

    const erro = textoOuVazio(m.error);
    if (erro) detalheReuEl.appendChild(el('p', 'gap', '⚠ ' + erro));

    if (status === 'waiting_room') {
      detalheReuEl.appendChild(el('p', 'gap',
        '⚠ O bot está na sala de espera. Alguém precisa admitir o bot na sala de espera.'));
    }

    // Participantes
    if (participantes.length) {
      const chips = el('div', 'parts');
      for (const p of participantes) {
        const chip = el('span', 'chip ' + corDe(p.nome));
        chip.appendChild(document.createTextNode(p.nome));
        if (p.isHost) chip.appendChild(el('span', 'host', 'anfitrião'));
        chips.appendChild(chip);
      }
      detalheReuEl.appendChild(chips);
    }

    // Ações
    const acoes = el('div', 'actions');

    const chatproStatus = textoOuVazio(campo(m, 'chatproStatus', 'chatpro_status'));
    const btnEnviar = el('button', 'btn',
      chatproStatus === 'sent' ? 'Enviado ao chatPro ✓' : 'Enviar pro chatPro');
    btnEnviar.disabled = chatproStatus === 'sent' || !falas.length;
    btnEnviar.addEventListener('click', async () => {
      btnEnviar.disabled = true;
      btnEnviar.textContent = 'Enviando…';
      limparMensagem();
      let resposta = null;
      let corpo = null;
      try {
        resposta = await fetch('/api/meetings/' + encodeURIComponent(m.id) + '/send-chatpro',
          { method: 'POST' });
        corpo = await resposta.json().catch(() => null);
      } catch (_) {
        mostrarErro('Não foi possível falar com o servidor.');
        btnEnviar.disabled = false;
        btnEnviar.textContent = 'Enviar pro chatPro';
        return;
      }
      const st = corpo && typeof corpo.status === 'string' ? corpo.status : '';
      if (st === 'sent') {
        mostrarOk('Transcrição entregue ao chatPro.');
      } else if (st === 'skipped-no-url') {
        mostrarAviso('chatPro ainda não configurado no servidor — nada foi enviado.');
      } else {
        mostrarErro(mensagemDeErro(corpo, resposta.status, 'Não foi possível enviar ao chatPro'));
      }
      btnEnviar.textContent = st === 'sent'
        ? 'Enviado ao chatPro ✓'
        : (st === 'skipped-no-url' ? 'chatPro não configurado' : 'Falhou — tentar de novo');
      btnEnviar.disabled = st === 'sent';
      // O PAINEL DE REUNIÕES é outra entrega, e ela pode ter ficado em dúvida
      // mesmo com o comentário entregue: o POST estourou o timeout e o painel
      // pode ter salvo a transcrição antes de a resposta se perder. O servidor
      // não reenvia sozinho nesse caso (reenviar duplicaria a transcrição do
      // cliente lá), então quem decide é quem está olhando esta tela.
      if (corpo && corpo.painelPrecisaConfirmacao && typeof corpo.aviso === 'string') {
        mostrarAviso(corpo.aviso);
        if (window.confirm(corpo.aviso + '\\n\\nReenviar mesmo assim ao painel?')) {
          try {
            const rf = await fetch('/api/meetings/' + encodeURIComponent(m.id)
              + '/send-chatpro?forcar=true', { method: 'POST' });
            const cf = await rf.json().catch(() => null);
            if (cf && cf.painelStatus === 'enviado') {
              mostrarOk('Transcrição reenviada e confirmada pelo painel.');
            } else if (cf && typeof cf.aviso === 'string') {
              mostrarAviso(cf.aviso);
            } else {
              mostrarErro('Não foi possível confirmar o reenvio ao painel.');
            }
          } catch (_) {
            mostrarErro('Não foi possível falar com o servidor no reenvio ao painel.');
          }
        }
      }
      // Força o redesenho: o chatpro_status mudou no servidor.
      assinaturaRenderizada = '';
      carregarReunioes();
    });
    acoes.appendChild(btnEnviar);

    if (falas.length) {
      const btnCopiar = el('button', 'btn ghost', 'Copiar transcrição');
      btnCopiar.addEventListener('click', async () => {
        const texto = falas
          .map((f) => '[' + fmtMs(f.startMs) + '] ' + f.speaker + ': ' + f.text)
          .join('\\n');
        try {
          await navigator.clipboard.writeText(texto);
          btnCopiar.textContent = 'Copiado ✓';
          setTimeout(() => { btnCopiar.textContent = 'Copiar transcrição'; }, 2000);
        } catch (_) {
          btnCopiar.textContent = 'Não foi possível copiar';
        }
      });
      acoes.appendChild(btnCopiar);
    }

    // Só faz sentido tirar o bot enquanto ele está gravando.
    if (status === 'recording') {
      const btnSair = el('button', 'btn perigo', 'Remover bot da chamada');
      btnSair.addEventListener('click', async () => {
        btnSair.disabled = true;
        btnSair.textContent = 'Removendo…';
        limparMensagem();
        try {
          const r = await fetch('/api/meetings/' + encodeURIComponent(m.id) + '/leave',
            { method: 'POST' });
          if (!r.ok) {
            const corpo = await r.json().catch(() => null);
            mostrarErro(mensagemDeErro(corpo, r.status, 'Não foi possível remover o bot'));
            btnSair.disabled = false;
            btnSair.textContent = 'Falhou — tentar de novo';
            return;
          }
          btnSair.textContent = 'Bot removido';
          mostrarOk('Pedido de saída enviado. O bot sai da chamada em instantes.');
        } catch (_) {
          btnSair.disabled = false;
          btnSair.textContent = 'Falhou — tentar de novo';
          mostrarErro('Não foi possível falar com o servidor.');
          return;
        }
        assinaturaRenderizada = '';
        carregarReunioes();
      });
      acoes.appendChild(btnSair);
    }

    if (chatproStatus && chatproStatus !== 'sent') {
      acoes.appendChild(el('span', 'note',
        'chatPro: ' + (ROTULO_CHATPRO.get(chatproStatus) || chatproStatus)));
    }
    detalheReuEl.appendChild(acoes);

    // Transcrição
    if (!falas.length) {
      detalheReuEl.appendChild(el('p', 'note', mensagemSemTranscricao(status)));
      return;
    }

    detalheReuEl.appendChild(el('p', 'note',
      falas.length + ' falas · ' + participantes.length + ' participante(s)'));

    const totalPaginas = Math.ceil(falas.length / POR_PAGINA_REUNIAO);
    let pagina = 0;
    const lista = el('div', null);
    const nav = el('div', 'actions');
    detalheReuEl.appendChild(lista);
    if (totalPaginas > 1) detalheReuEl.appendChild(nav);

    function desenharPaginaReuniao() {
      lista.replaceChildren();
      const ini = pagina * POR_PAGINA_REUNIAO;
      for (const f of falas.slice(ini, ini + POR_PAGINA_REUNIAO)) {
        const anfitriao = f.isHost === true || ehAnfitriao.has(f.speaker);
        const row = el('div', 'line reuniao' + (anfitriao ? ' anfitriao' : ''));
        const quem = el('div', 'who ' + corDe(f.speaker));
        quem.appendChild(el('div', null, f.speaker));
        if (anfitriao) quem.appendChild(el('div', 'host', 'anfitrião'));
        quem.appendChild(el('div', 't', fmtMs(f.startMs)));
        row.appendChild(quem);
        row.appendChild(el('div', 'txt', f.text));
        lista.appendChild(row);
      }
      if (totalPaginas > 1) {
        nav.replaceChildren();
        const ant = el('button', 'btn ghost', '← Anteriores');
        ant.disabled = pagina === 0;
        ant.addEventListener('click', () => { pagina--; desenharPaginaReuniao(); lista.scrollIntoView(); });
        const prox = el('button', 'btn ghost', 'Próximas →');
        prox.disabled = pagina >= totalPaginas - 1;
        prox.addEventListener('click', () => { pagina++; desenharPaginaReuniao(); lista.scrollIntoView(); });
        nav.appendChild(ant);
        nav.appendChild(el('span', 'note', 'Página ' + (pagina + 1) + ' de ' + totalPaginas));
        nav.appendChild(prox);
      }
    }
    desenharPaginaReuniao();
  }

  function mensagemSemTranscricao(status) {
    if (status === 'failed') return 'A reunião falhou — não há transcrição.';
    if (status === 'done' || status === 'ended') return 'Transcrição vazia (nenhuma fala detectada).';
    if (status === 'waiting_room') return 'O bot ainda está esperando ser admitido na sala.';
    if (status === 'recording') return 'Gravando. A transcrição aparece quando a reunião terminar.';
    return 'A transcrição aparece aqui quando a reunião terminar.';
  }

  // ─── Supervisão: indicadores, gráfico por dia e busca ─────────────────────

  const superCorpoEl = document.getElementById('super-corpo');
  const superToggleEl = document.getElementById('super-toggle');
  const superAvisoEl = document.getElementById('super-aviso');
  const kpisEl = document.getElementById('kpis');
  const porAtendenteEl = document.getElementById('por-atendente');
  const graficoEl = document.getElementById('grafico');
  const buscaEl = document.getElementById('busca-campo');
  const buscaStatusEl = document.getElementById('busca-status');
  const resultadosEl = document.getElementById('busca-resultados');

  const DIAS_SUPERVISAO = 7;
  // A lista de reuniões atualiza a cada 10s; o resumo é caro e muda devagar.
  const INTERVALO_RESUMO_MS = 60000;
  const ESPERA_BUSCA_MS = 350;
  const MIN_BUSCA = 2;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, atributos) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const chave of Object.keys(atributos || {})) {
      e.setAttribute(chave, String(atributos[chave]));
    }
    return e;
  }

  /** Aceita envelope ({resumo:{...}}) ou objeto cru, camelCase ou snake_case. */
  function normalizarResumo(data) {
    const bruto = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    const r = (bruto.resumo && typeof bruto.resumo === 'object') ? bruto.resumo : bruto;

    const porDia = [];
    const dias = campo(r, 'porDia', 'por_dia');
    if (Array.isArray(dias)) {
      for (const d of dias) {
        if (!d || typeof d !== 'object') continue;
        porDia.push({
          dia: textoOuVazio(d.dia || d.data || d.day),
          total: numero(d.total),
          gravadas: numero(d.gravadas),
        });
      }
    }

    const porAtendente = [];
    const atendentes = campo(r, 'porAtendente', 'por_atendente');
    if (Array.isArray(atendentes)) {
      for (const a of atendentes) {
        if (!a || typeof a !== 'object') continue;
        const nome = textoOuVazio(a.nome || a.name);
        if (!nome) continue;
        porAtendente.push({ nome: nome, total: numero(a.total) });
      }
    }

    return {
      total: numero(r.total),
      gravadas: numero(r.gravadas),
      semGravacao: numero(campo(r, 'semGravacao', 'sem_gravacao')),
      semTranscricao: numero(campo(r, 'semTranscricao', 'sem_transcricao')),
      porDia: porDia,
      porAtendente: porAtendente,
    };
  }

  let resumoUltimaBusca = 0;
  let resumoAssinatura = '';
  let resumoCarregado = false;

  async function carregarResumo(forcar) {
    const agora = Date.now();
    if (!forcar && agora - resumoUltimaBusca < INTERVALO_RESUMO_MS) return;
    resumoUltimaBusca = agora;

    let data;
    try {
      const res = await fetch('/api/meetings/resumo-supervisao?dias=' + DIAS_SUPERVISAO);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (_) {
      // A rota pode nem existir ainda: avisa baixinho, sem derrubar a aba.
      superAvisoEl.textContent = 'Indicadores indisponíveis no momento.';
      if (!resumoCarregado) {
        kpisEl.replaceChildren();
        graficoEl.replaceChildren();
        porAtendenteEl.textContent = '';
      }
      return;
    }

    superAvisoEl.textContent = '';
    resumoCarregado = true;
    const resumo = normalizarResumo(data);
    // Redesenhar só quando muda evita a faixa piscar a cada atualização.
    const assinatura = JSON.stringify(resumo);
    if (assinatura === resumoAssinatura) return;
    resumoAssinatura = assinatura;
    desenharKpis(resumo);
    desenharGrafico(resumo.porDia);
  }

  function cartao(valor, rotulo, classe) {
    const caixa = el('div', 'kpi' + (classe ? ' ' + classe : ''));
    caixa.appendChild(el('div', 'n', String(valor)));
    caixa.appendChild(el('div', 'r', rotulo));
    return caixa;
  }

  function desenharKpis(r) {
    kpisEl.replaceChildren();
    kpisEl.appendChild(cartao(r.total, 'reuniões nos últimos 7 dias'));
    kpisEl.appendChild(cartao(r.gravadas, 'gravadas pelo bot', r.gravadas > 0 ? 'bom' : ''));
    kpisEl.appendChild(cartao(r.semGravacao, 'SEM gravação',
      r.semGravacao > 0 ? 'destaque' : ''));
    kpisEl.appendChild(cartao(r.semTranscricao, 'sem transcrição',
      r.semTranscricao > 0 ? 'atencao' : ''));

    if (!r.porAtendente.length) {
      porAtendenteEl.textContent = '';
      return;
    }
    const maiores = r.porAtendente.slice().sort((a, b) => b.total - a.total).slice(0, 4);
    const partes = [];
    for (const a of maiores) partes.push(a.nome + ' ' + a.total);
    porAtendenteEl.textContent = 'Por atendente: ' + partes.join(' · ');
  }

  /** 'AAAA-MM-DD' vira 'DD/MM' sem passar por Date — fuso não pode virar o dia. */
  function rotuloDia(dia) {
    const partes = String(dia || '').split('-');
    if (partes.length === 3) return partes[2] + '/' + partes[1];
    return dia || '—';
  }

  function desenharGrafico(porDia) {
    graficoEl.replaceChildren();
    if (!porDia.length) {
      graficoEl.appendChild(el('p', 'super-aviso', 'Ainda não há reuniões nestes 7 dias.'));
      return;
    }

    const COLUNA = 60;
    const BARRA = 26;
    const ALTURA = 132;
    const BASE = 104;
    const TOPO = 22;
    const UTIL = BASE - TOPO;
    const largura = COLUNA * porDia.length;

    let maior = 1;
    let somaTotal = 0;
    let somaFalta = 0;
    for (const d of porDia) {
      if (d.total > maior) maior = d.total;
      somaTotal += d.total;
      somaFalta += Math.max(d.total - Math.min(d.gravadas, d.total), 0);
    }

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + largura + ' ' + ALTURA,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
    });
    svg.setAttribute('aria-label',
      'Reuniões por dia nos últimos ' + porDia.length + ' dias: ' + somaTotal +
      ' no total, ' + somaFalta + ' sem gravação.');
    svg.appendChild(svgEl('line',
      { x1: 0, y1: BASE + 0.5, x2: largura, y2: BASE + 0.5, class: 'g-eixo' }));

    for (let i = 0; i < porDia.length; i++) {
      const d = porDia[i];
      const gravadas = Math.min(Math.max(d.gravadas, 0), Math.max(d.total, 0));
      const faltando = Math.max(d.total - gravadas, 0);
      const centro = i * COLUNA + COLUNA / 2;
      const x = centro - BARRA / 2;
      const alturaTotal = d.total > 0 ? Math.max((d.total / maior) * UTIL, 4) : 0;
      const alturaOk = d.total > 0 ? (gravadas / d.total) * alturaTotal : 0;
      const alturaFalta = alturaTotal - alturaOk;

      const grupo = svgEl('g', {});
      const titulo = svgEl('title', {});
      titulo.textContent = rotuloDia(d.dia) + ': ' + d.total + ' reunião(ões), ' +
        gravadas + ' gravada(s), ' + faltando + ' sem gravação';
      grupo.appendChild(titulo);

      if (alturaTotal <= 0) {
        grupo.appendChild(svgEl('rect',
          { x: x, y: BASE - 3, width: BARRA, height: 3, rx: 1.5, class: 'g-vazio' }));
      } else {
        if (alturaFalta > 0) {
          grupo.appendChild(svgEl('rect',
            { x: x, y: BASE - alturaTotal, width: BARRA, height: alturaFalta, rx: 3,
              class: 'g-falta' }));
        }
        if (alturaOk > 0) {
          grupo.appendChild(svgEl('rect',
            { x: x, y: BASE - alturaOk, width: BARRA, height: alturaOk, rx: 3,
              class: 'g-ok' }));
        }
      }

      const numeroTexto = svgEl('text',
        { x: centro, y: BASE - alturaTotal - 6, 'text-anchor': 'middle', class: 'g-rot g-num' });
      numeroTexto.textContent = String(d.total);
      grupo.appendChild(numeroTexto);

      const rotulo = svgEl('text',
        { x: centro, y: BASE + 17, 'text-anchor': 'middle', class: 'g-rot' });
      rotulo.textContent = rotuloDia(d.dia);
      grupo.appendChild(rotulo);

      svg.appendChild(grupo);
    }

    graficoEl.appendChild(svg);

    const legenda = el('div', 'g-legenda');
    for (const par of [['ok', 'gravadas'], ['falta', 'sem gravação']]) {
      const item = el('span', null);
      item.appendChild(el('span', 'pt ' + par[0]));
      item.appendChild(document.createTextNode(par[1]));
      legenda.appendChild(item);
    }
    graficoEl.appendChild(legenda);
  }

  // ── Busca nas transcrições ──

  function normalizarResultados(data) {
    let bruto = null;
    if (Array.isArray(data)) bruto = data;
    else if (data && Array.isArray(data.resultados)) bruto = data.resultados;
    else if (data && Array.isArray(data.results)) bruto = data.results;
    if (!bruto) return [];
    const saida = [];
    for (const r of bruto) {
      if (!r || typeof r !== 'object') continue;
      saida.push({
        meetingId: textoOuVazio(campo(r, 'meetingId', 'meeting_id')),
        sessionId: textoOuVazio(campo(r, 'sessionId', 'session_id')),
        meetingCode: textoOuVazio(campo(r, 'meetingCode', 'meeting_code')),
        quando: textoOuVazio(r.quando || campo(r, 'startedAt', 'started_at')),
        trecho: textoOuVazio(r.trecho || r.texto || r.text),
      });
    }
    return saida;
  }

  /** Realça o termo sem HTML cru: pedaços de texto + <mark> montados no DOM. */
  function marcarTrecho(texto, termo) {
    const frag = document.createDocumentFragment();
    const minusculo = texto.toLowerCase();
    const alvo = termo.toLowerCase();
    let i = 0;
    while (alvo && i < texto.length) {
      const achou = minusculo.indexOf(alvo, i);
      if (achou < 0) break;
      if (achou > i) frag.appendChild(document.createTextNode(texto.slice(i, achou)));
      frag.appendChild(el('mark', 'realce', texto.slice(achou, achou + alvo.length)));
      i = achou + alvo.length;
    }
    if (i < texto.length) frag.appendChild(document.createTextNode(texto.slice(i)));
    return frag;
  }

  function fecharResultados() {
    resultadosEl.classList.add('oculto');
    resultadosEl.replaceChildren();
  }

  function desenharResultados(itens, termo) {
    resultadosEl.replaceChildren();
    if (!itens.length) {
      buscaStatusEl.textContent = 'Nada encontrado para "' + termo + '".';
      resultadosEl.classList.add('oculto');
      return;
    }
    buscaStatusEl.textContent = itens.length === 1
      ? '1 trecho encontrado'
      : itens.length + ' trechos encontrados';

    for (const r of itens) {
      const botao = el('button', 'res');
      botao.type = 'button';
      botao.appendChild(el('div', 'rc', r.meetingCode || '(sem código)'));
      const detalhe = fmtTime(r.quando) + (r.sessionId ? ' · sessão ' + r.sessionId : '');
      botao.appendChild(el('div', 'rq', detalhe));
      const trecho = el('div', 'rt');
      trecho.appendChild(marcarTrecho(r.trecho, termo));
      botao.appendChild(trecho);
      if (r.meetingId) {
        botao.addEventListener('click', () => {
          fecharResultados();
          ativarAba('reunioes');
          selecionarReuniao(r.meetingId);
        });
      }
      resultadosEl.appendChild(botao);
    }
    resultadosEl.classList.remove('oculto');
  }

  let buscaSeq = 0;
  let buscaTimer = 0;

  async function buscar(bruto) {
    const termo = String(bruto || '').trim();
    if (termo.length < MIN_BUSCA) {
      buscaSeq++;
      fecharResultados();
      buscaStatusEl.textContent = termo.length
        ? 'Digite ao menos ' + MIN_BUSCA + ' caracteres.'
        : '';
      return;
    }

    const seq = ++buscaSeq;
    buscaStatusEl.textContent = 'Procurando…';
    let data;
    try {
      const res = await fetch('/api/meetings/busca?q=' + encodeURIComponent(termo));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (_) {
      if (seq !== buscaSeq) return;
      fecharResultados();
      buscaStatusEl.textContent = 'Busca indisponível no momento.';
      return;
    }
    // Resposta atrasada de um termo antigo não pode sobrescrever a busca atual.
    if (seq !== buscaSeq) return;
    desenharResultados(normalizarResultados(data), termo);
  }

  buscaEl.addEventListener('input', () => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(() => buscar(buscaEl.value), ESPERA_BUSCA_MS);
  });
  buscaEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      clearTimeout(buscaTimer);
      buscar(buscaEl.value);
    } else if (ev.key === 'Escape') {
      clearTimeout(buscaTimer);
      buscaSeq++;
      fecharResultados();
      buscaStatusEl.textContent = '';
    }
  });
  document.addEventListener('click', (ev) => {
    if (ev.target !== buscaEl && !resultadosEl.contains(ev.target)) fecharResultados();
  });

  // ── Mostrar/ocultar a faixa (a tela tem altura fixa; a lista precisa de espaço) ──

  const CHAVE_SUPERVISAO = 'chatpro.supervisao.oculta';

  function aplicarSupervisao(oculta) {
    superCorpoEl.classList.toggle('oculto', oculta);
    superToggleEl.setAttribute('aria-expanded', oculta ? 'false' : 'true');
    superToggleEl.textContent = oculta ? 'mostrar' : 'ocultar';
    if (oculta) fecharResultados();
    try {
      localStorage.setItem(CHAVE_SUPERVISAO, oculta ? '1' : '0');
    } catch (_) {
      // Navegação privada bloqueia o storage: a preferência só não persiste.
    }
  }

  superToggleEl.addEventListener('click', () => {
    aplicarSupervisao(!superCorpoEl.classList.contains('oculto'));
  });

  let supervisaoOculta = false;
  try {
    supervisaoOculta = localStorage.getItem(CHAVE_SUPERVISAO) === '1';
  } catch (_) {
    supervisaoOculta = false;
  }
  aplicarSupervisao(supervisaoOculta);

  // ── Formulário: chamar o bot ──

  function mostrarErro(texto) {
    msgEl.className = 'msg erro';
    msgEl.textContent = texto;
  }
  function mostrarOk(texto) {
    msgEl.className = 'msg ok';
    msgEl.textContent = texto;
  }
  function mostrarAviso(texto) {
    msgEl.className = 'msg';
    msgEl.textContent = texto;
  }
  function limparMensagem() {
    msgEl.className = 'msg';
    msgEl.textContent = '';
  }

  /** UUID sem regex (o arquivo é um template literal — menos escape, menos risco). */
  function pareceUuid(v) {
    if (v.length !== 36) return false;
    const hex = '0123456789abcdefABCDEF';
    for (let i = 0; i < 36; i++) {
      const c = v.charAt(i);
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        if (c !== '-') return false;
      } else if (hex.indexOf(c) < 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Mensagem legível a partir da resposta de erro da API
   * ({error, detail, hint} ou {error, issues:[{message}]}).
   */
  function mensagemDeErro(data, status, alternativa) {
    const partes = [];
    if (data && typeof data === 'object') {
      if (typeof data.error === 'string') partes.push(data.error);
      if (typeof data.detail === 'string') partes.push(data.detail);
      if (typeof data.motivo === 'string') partes.push(data.motivo);
      if (typeof data.hint === 'string') partes.push(data.hint);
      if (Array.isArray(data.issues)) {
        for (const issue of data.issues) {
          if (issue && typeof issue.message === 'string') partes.push(issue.message);
        }
      }
    }
    if (partes.length) return partes.join(' ');
    if (status === 404) return 'O servidor não tem essa rota. Confira a configuração.';
    return alternativa + ' (HTTP ' + status + ').';
  }

  async function criarReuniao() {
    const url = urlEl.value.trim();
    const sessao = sessaoEl.value.trim();
    limparMensagem();

    if (!url) {
      mostrarErro('Cole a URL do Meet.');
      urlEl.focus();
      return;
    }
    if (url.indexOf(PREFIXO_MEET) !== 0) {
      mostrarErro('A URL precisa ser de uma reunião do Google Meet (' + PREFIXO_MEET + '...).');
      urlEl.focus();
      return;
    }
    if (sessao && !pareceUuid(sessao)) {
      mostrarErro('A sessão do chatPro precisa ser um uuid (36 caracteres).');
      sessaoEl.focus();
      return;
    }

    const corpo = { meetingUrl: url };
    if (sessao) corpo.sessionId = sessao;

    btnCriarEl.disabled = true;
    btnCriarEl.textContent = 'Enviando…';
    try {
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        mostrarErro(mensagemDeErro(data, res.status, 'Não foi possível enviar o bot'));
        return;
      }
      urlEl.value = '';
      sessaoEl.value = '';
      mostrarOk('Bot a caminho. Alguém precisa admitir o bot na sala de espera.');
      const criada = objetoDe(data);
      await carregarReunioes();
      carregarResumo(true);
      const novoId = criada && typeof criada.id === 'string' ? criada.id : '';
      if (novoId) selecionarReuniao(novoId);
    } catch (_) {
      mostrarErro('Não foi possível falar com o servidor.');
    } finally {
      btnCriarEl.disabled = false;
      btnCriarEl.textContent = 'Enviar bot pra reunião';
    }
  }

  btnCriarEl.addEventListener('click', criarReuniao);
  for (const campoTexto of [urlEl, sessaoEl]) {
    campoTexto.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); criarReuniao(); }
    });
  }

  // ─── Início ───────────────────────────────────────────────────────────────

  ativarAba(location.hash === '#capturas' ? 'capturas' : 'reunioes');
  // O status da reunião muda sozinho (webhook) — atualiza só a aba visível.
  setInterval(atualizarAbaAtiva, 10000);
})();
</script>
</body>
</html>`;
}
