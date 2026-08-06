/**
 * HTML da página de revisão (servido em GET /).
 *
 * Autocontido (CSS + JS inline), identidade visual chatPro. O JS monta o DOM
 * com textContent — nunca innerHTML com dado dinâmico. Textos em português.
 */
export function reviewPageHtml(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chatPro — Revisão de transcrições</title>
<style>
  :root {
    --verde: #25D066; --verde-hover: #1BAD53; --neon: #24FF72;
    --bg: #1d2125; --surface: #22272b; --card: #2c333a;
    --cinza1: #D1D1D5; --cinza2: #E6E5E8; --texto: #F1F0F2;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--texto);
    font-family: 'Space Grotesk', system-ui, sans-serif; }
  header { background: var(--surface); padding: 18px 24px; border-bottom: 1px solid #000;
    display: flex; align-items: baseline; gap: 12px; }
  header .logo { font-weight: 800; font-size: 22px; color: var(--verde); letter-spacing: .3px; }
  header .sub { color: var(--cinza1); font-size: 14px; }
  .wrap { display: grid; grid-template-columns: 320px 1fr; gap: 0; height: calc(100vh - 61px); }
  .list { border-right: 1px solid #000; overflow-y: auto; background: var(--surface); }
  .item { padding: 14px 18px; border-bottom: 1px solid #1a1e22; cursor: pointer; }
  .item:hover { background: var(--card); }
  .item.sel { background: var(--card); border-left: 3px solid var(--verde); }
  .item .code { font-weight: 700; color: var(--texto); }
  .item .meta { font-size: 12px; color: var(--cinza1); margin-top: 4px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
    font-weight: 700; }
  .badge.ok { background: rgba(37,208,102,.15); color: var(--verde); }
  .badge.warn { background: rgba(255,196,0,.15); color: #ffc400; }
  .badge.mut { background: #1a1e22; color: var(--cinza1); }
  .detail { overflow-y: auto; padding: 24px 28px; }
  .empty { color: var(--cinza1); margin-top: 40px; text-align: center; }
  .cov { margin: 8px 0 18px; }
  .bar { height: 8px; background: #1a1e22; border-radius: 999px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--verde); }
  .gap { color: #ffc400; font-size: 13px; margin: 3px 0; }
  .players { display: flex; gap: 16px; flex-wrap: wrap; margin: 12px 0 20px; }
  .players div { font-size: 12px; color: var(--cinza1); }
  audio { display: block; margin-top: 4px; }
  .line { display: grid; grid-template-columns: 96px 1fr; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid #1a1e22; }
  .who { font-weight: 700; font-size: 13px; }
  .who.at { color: var(--verde); }
  .who.cl { color: var(--neon); }
  .who.ot { color: var(--cinza1); }
  .t { font-size: 12px; color: var(--cinza1); }
  .txt { line-height: 1.5; }
  .btn { background: var(--verde); color: #05130a; border: none; padding: 11px 20px;
    border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .btn:hover { background: var(--verde-hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.ghost { background: transparent; color: var(--cinza1); border: 1px solid #3a424a; }
  .btn.ghost:hover { background: var(--card); color: var(--texto); }
  .actions { margin: 18px 0 8px; display: flex; align-items: center; gap: 14px; }
  .note { font-size: 12px; color: var(--cinza1); }
  h2 { margin: 0 0 4px; }
</style>
</head>
<body>
<header>
  <span class="logo">chatPro</span>
  <span class="sub">Revisão de transcrições — confira antes de enviar pra Voreo</span>
</header>
<div class="wrap">
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><p class="empty">Selecione uma captura à esquerda.</p></div>
</div>
<script>
(() => {
  'use strict';
  const listEl = document.getElementById('list');
  const detailEl = document.getElementById('detail');
  let selected = null;

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
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function statusBadge(status) {
    const map = { 'ready-for-review': 'ok', 'sent': 'ok', 'failed': 'warn' };
    const b = el('span', 'badge ' + (map[status] || 'mut'), status || '—');
    return b;
  }

  async function loadList() {
    const res = await fetch('/api/captures');
    const data = await res.json();
    listEl.replaceChildren();
    if (!data.captures.length) {
      listEl.appendChild(el('p', 'empty', 'Nenhuma captura ainda. Entre num Meet com a extensão ativa.'));
      return;
    }
    for (const c of data.captures) {
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
    const res = await fetch('/api/captures/' + id);
    if (!res.ok) { detailEl.replaceChildren(el('p', 'empty', 'Falha ao carregar.')); return; }
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

  loadList();
  setInterval(loadList, 10000); // atualiza a lista periodicamente
})();
</script>
</body>
</html>`;
}
