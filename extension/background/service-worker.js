/**
 * Service worker da extensão — a ponte entre o botão no chatPro e o backend.
 *
 * MV3 dorme depois de ~30 s e perde tudo que estava em memória, então **todo
 * estado vive em chrome.storage** e os listeners ficam no topo do arquivo (se
 * forem registrados dentro de um callback, o worker acorda sem eles).
 */

const PADRAO = {
  backendUrl: 'http://localhost:3333',
  panelToken: '',
  deviceId: '',
};

/**
 * O deviceId é o que amarra a conta Google conectada — perdê-lo obriga a pessoa
 * a reconectar, sem entender por quê.
 *
 * Por isso ele mora em `storage.sync`, não em `local`: **remover e carregar a
 * extensão de novo APAGA o storage local**, e a conexão com o Google iria junto.
 * O sync sobrevive à reinstalação (fica no perfil do Chrome) e ainda cobre a
 * mesma pessoa em dois computadores com um vínculo só.
 *
 * Sem login no Chrome o sync não sincroniza, mas continua persistindo local —
 * então não há caso em que isto seja pior que `local`.
 */
async function lerDeviceId() {
  const doSync = await chrome.storage.sync.get('deviceId').catch(() => ({}));
  if (doSync.deviceId) return doSync.deviceId;

  // Migração: quem já instalou antes tem o id no local. Promove pro sync em vez
  // de gerar outro, senão a conta Google já conectada seria abandonada.
  const doLocal = await chrome.storage.local.get('deviceId');
  const id = doLocal.deviceId || crypto.randomUUID();
  await chrome.storage.sync.set({ deviceId: id }).catch(() => {});
  await chrome.storage.local.set({ deviceId: id });
  return id;
}

async function config() {
  const guardado = await chrome.storage.local.get(Object.keys(PADRAO));
  const cfg = { ...PADRAO, ...guardado };
  cfg.deviceId = await lerDeviceId();
  return cfg;
}

function comToken(cfg, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (cfg.panelToken) h.Authorization = `Bearer ${cfg.panelToken}`;
  return h;
}

async function chamar(caminho, opcoes = {}) {
  const cfg = await config();
  const base = String(cfg.backendUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Endereço do servidor não configurado na extensão.');

  let resposta;
  try {
    resposta = await fetch(`${base}${caminho}`, {
      ...opcoes,
      headers: comToken(cfg, opcoes.headers),
    });
  } catch (err) {
    // `fetch` só estoura assim quando NÃO houve resposta: servidor parado,
    // endereço errado, porta ocupada. O "Failed to fetch" do Chrome não diz
    // nada disso — troca por algo acionável, com o endereço que tentamos.
    throw new Error(
      `Não consegui alcançar o servidor em ${base}. ` +
        'Confira se ele está rodando (autostart) e se o endereço no popup está certo. ' +
        `(${String(err?.message || err)})`
    );
  }

  const texto = await resposta.text();
  let corpo = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = { error: texto.slice(0, 200) };
  }
  return { status: resposta.status, ok: resposta.ok, corpo };
}

// ─── Mensagens vindas do content script e do popup ───────────────────────────

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  (async () => {
    try {
      if (msg?.tipo === 'INICIAR_REUNIAO') {
        const cfg = await config();
        const r = await chamar('/api/reunioes/iniciar', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: msg.sessionId,
            deviceId: cfg.deviceId,
            contato: msg.contato ?? null,
            // Só vai quando o atendente marcou hora; sem isso é reunião agora.
            ...(msg.quando ? { quando: msg.quando } : {}),
            // Campos do fluxo comercial — só entram quando existem, pra não
            // quebrar a validação do servidor com null onde ele espera ausência.
            ...(msg.tipoReuniao ? { tipo: msg.tipoReuniao } : {}),
            ...(msg.atendenteEmail ? { atendenteEmail: msg.atendenteEmail } : {}),
            ...(msg.atendenteUserId ? { atendenteUserId: msg.atendenteUserId } : {}),
            ...(msg.cliente ? { cliente: msg.cliente } : {}),
            ...(msg.vendedorEmail ? { vendedorEmail: msg.vendedorEmail } : {}),
            // `assignee_email` é o único campo que a aba só manda com permissão
            // do painel: quem não pode escolher o responsável leva 403.
            ...(msg.assigneeEmail ? { assigneeEmail: msg.assigneeEmail } : {}),
          }),
        });
        if (r.ok) {
          responder({ ok: true, dados: r.corpo });
          return;
        }
        // A recusa do zod vem em `issues`, e é ela que diz o que corrigir
        // ("esse horário já passou"). Sem isto o atendente via só
        // "Corpo inválido." e não tinha o que fazer com a informação.
        const issues = Array.isArray(r.corpo?.issues)
          ? r.corpo.issues.map((i) => i?.message).filter(Boolean).join(' ')
          : '';
        responder({
          ok: false,
          erro: r.corpo?.error || issues || `Servidor respondeu ${r.status}.`,
          detalhe: r.corpo?.detail || null,
          precisaConectar: Boolean(r.corpo?.precisaConectar),
          recarregarHorarios: Boolean(r.corpo?.recarregarHorarios),
          // Estes três decidem se a tela pode oferecer "tentar de novo":
          // repetir um POST que talvez tenha criado a reunião duplica um
          // compromisso real, com e-mail e agenda de gente de verdade.
          naoRepetir: Boolean(r.corpo?.naoRepetir),
          incerto: Boolean(r.corpo?.incerto),
          meetUrl: r.corpo?.meetUrl || null,
          hint: r.corpo?.hint || null,
        });
        return;
      }

      // ─── Painel de reuniões ────────────────────────────────────────────
      // Estes três desenham a aba: quem é a pessoa, o que ela pode marcar e
      // quais horários existem. Todos devolvem o corpo do painel achatado —
      // a aba não deveria precisar saber que houve um servidor no meio.

      if (msg?.tipo === 'PAINEL_ME') {
        const r = await chamar(`/api/painel/me?email=${encodeURIComponent(msg.email || '')}`);
        responder(
          r.ok
            ? r.corpo
            : { identificado: false, erro: r.corpo?.error || `Servidor respondeu ${r.status}.` }
        );
        return;
      }

      if (msg?.tipo === 'PAINEL_HORARIOS') {
        const params = new URLSearchParams({
          tipo: msg.tipoReuniao || '',
          data: msg.data || '',
          email: msg.email || '',
        });
        if (msg.clientType) params.set('clientType', msg.clientType);
        const r = await chamar(`/api/painel/horarios?${params.toString()}`);
        responder(r.ok ? r.corpo : { disponivel: false, grade: null });
        return;
      }

      // Gera o checklist de onboarding da migração. É a ÚNICA chamada de
      // escrita que a aba dispara antes de marcar, e só com clique explícito:
      // cria um registro de verdade no painel.
      if (msg?.tipo === 'PAINEL_GERAR_MIGRACAO') {
        const r = await chamar('/api/painel/migracao/link', {
          method: 'POST',
          body: JSON.stringify({
            cnpj: msg.cnpj,
            vendedorEmail: msg.vendedorEmail,
            instanceCode: msg.instanceCode,
          }),
        });
        responder(
          r.ok
            ? { ok: true, ...r.corpo }
            : { ok: false, error: r.corpo?.error, detail: r.corpo?.detail }
        );
        return;
      }

      if (msg?.tipo === 'PAINEL_VENDEDORES') {
        const r = await chamar('/api/painel/vendedores');
        responder(r.ok ? r.corpo : { vendedores: [] });
        return;
      }

      if (msg?.tipo === 'PAINEL_MIGRACAO_STATUS') {
        const cnpj = String(msg.cnpj || '').replace(/\D/g, '');
        const r = await chamar(`/api/painel/onboarding?cnpj=${encodeURIComponent(cnpj)}`);
        responder(r.ok ? r.corpo : { encontrado: false });
        return;
      }

      // Razão social pelo CNPJ, pra aba preencher o campo Empresa sozinha
      // quando ele está vazio.
      //
      // Aqui NADA é erro: a rota é nova (servidor antigo devolve 404), o CNPJ
      // pode não estar em lugar nenhum, e o painel pode estar fora do ar. Os
      // três terminam no mesmo lugar — `encontrado:false`, campo continua vazio,
      // a pessoa digita. Deixar um desses virar erro na tela transformaria uma
      // conveniência em obstáculo no meio do formulário.
      if (msg?.tipo === 'PAINEL_CNPJ') {
        const cnpj = String(msg.cnpj || '').replace(/\D/g, '');
        if (cnpj.length !== 14) {
          responder({ encontrado: false });
          return;
        }
        const r = await chamar(`/api/painel/cnpj?cnpj=${encodeURIComponent(cnpj)}`);
        if (!r.ok) {
          responder({ encontrado: false, semRota: r.status === 404 });
          return;
        }
        // O corpo manda no `encontrado`: se a rota já responde `false`, é isso
        // que vale — o espalhamento vem depois do padrão de propósito.
        responder(
          r.corpo && typeof r.corpo === 'object'
            ? { encontrado: true, ...r.corpo }
            : { encontrado: false }
        );
        return;
      }

      if (msg?.tipo === 'CONSULTAR_ONBOARDING') {
        // Migração: o painel interno pode já ter os dados do cliente pelo CNPJ.
        // Erro aqui não é fatal — o content script segue com digitação manual.
        const cnpj = String(msg.cnpj || '').replace(/\D/g, '');
        const r = await chamar(`/api/painel/onboarding?cnpj=${encodeURIComponent(cnpj)}`);
        responder({ ok: r.ok, dados: r.corpo });
        return;
      }

      if (msg?.tipo === 'LISTAR_VENDEDORES') {
        const r = await chamar('/api/painel/vendedores');
        responder({ ok: r.ok, dados: r.corpo });
        return;
      }

      if (msg?.tipo === 'PAINEL_STATUS') {
        const r = await chamar('/api/painel/diagnostico');
        // 404 é "este servidor é mais antigo que a rota", não "o painel caiu".
        // O popup precisa distinguir os dois: no primeiro caso ele não sabe de
        // nada e mantém a conta Google em destaque; no segundo ele acusa o
        // problema. Um 404 virando erro vermelho mandaria a pessoa caçar um
        // defeito no painel que não existe.
        if (r.status === 404) {
          responder({ ok: false, semRota: true });
          return;
        }
        responder({ ok: r.ok, status: r.status, dados: r.corpo });
        return;
      }

      if (msg?.tipo === 'STATUS_GOOGLE') {
        const cfg = await config();
        const r = await chamar(`/api/google/status?device=${encodeURIComponent(cfg.deviceId)}`);
        responder({ ok: r.ok, dados: r.corpo, deviceId: cfg.deviceId });
        return;
      }

      if (msg?.tipo === 'CONECTAR_GOOGLE') {
        const cfg = await config();
        const base = String(cfg.backendUrl || '').replace(/\/+$/, '');
        const url =
          `${base}/oauth/google/conectar?device=${encodeURIComponent(cfg.deviceId)}` +
          (cfg.panelToken ? `&token=${encodeURIComponent(cfg.panelToken)}` : '');
        await chrome.tabs.create({ url });
        responder({ ok: true });
        return;
      }

      if (msg?.tipo === 'DESCONECTAR_GOOGLE') {
        const cfg = await config();
        const r = await chamar('/api/google/desconectar', {
          method: 'POST',
          body: JSON.stringify({ deviceId: cfg.deviceId }),
        });
        responder({ ok: r.ok });
        return;
      }

      responder({ ok: false, erro: 'Mensagem desconhecida.' });
    } catch (err) {
      responder({ ok: false, erro: String(err?.message || err) });
    }
  })();

  // true = a resposta vem depois (async).
  return true;
});
