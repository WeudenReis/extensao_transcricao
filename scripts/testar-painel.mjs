#!/usr/bin/env node
/**
 * Descobre, em segundos, se uma URL é mesmo a API do painel de reuniões.
 *
 *   node scripts/testar-painel.mjs <url-do-painel> [email-do-atendente]
 *   node scripts/testar-painel.mjs                  → usa PAINEL_API_URL do server/.env
 *
 * SÓ LEITURA. Nenhum POST é disparado, nunca — no painel, criar reunião gera
 * link do Meet de verdade, manda e-mail pro cliente, avisa no Slack e ocupa a
 * agenda de gente real. Um script de diagnóstico não tem esse direito.
 *
 * As camadas rodam em ordem e param na primeira que falha, porque cada uma é
 * pré-requisito da seguinte: sem host não há JSON, sem JSON não há token válido.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPO_LIMITE = 15000;

// ─── Enfeites de terminal ────────────────────────────────────────────────────

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const nao = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const meio = (s) => `\x1b[33m•\x1b[0m ${s}`;
const forte = (s) => `\x1b[1m${s}\x1b[0m`;
const p = (s = '') => console.log(s);

// ─── .env ────────────────────────────────────────────────────────────────────

/** Lê o .env sem depender de pacote nenhum. Arquivo ausente devolve {} — a
 *  falta de .env é um caso previsto (máquina nova), não um crash. */
function lerEnv(caminho) {
  let bruto;
  try {
    bruto = readFileSync(caminho, 'utf8');
  } catch {
    return null;
  }
  const env = {};
  for (const linha of bruto.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(linha)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    let valor = m[2].trim();
    // aspas em volta são delimitador do .env, não fazem parte do valor
    if (valor.length >= 2 && /^(".*"|'.*')$/.test(valor)) valor = valor.slice(1, -1);
    env[m[1]] = valor;
  }
  return env;
}

const caminhoEnv = join(raiz, 'server/.env');
const env = lerEnv(caminhoEnv);
const V = (chave) => (env && env[chave] ? env[chave] : null);

const tokenAgenda = V('PAINEL_EXT_AGENDA_TOKEN');
const tokenRetaguarda = V('PAINEL_RETAGUARDA_TOKEN');

/** Rede de segurança: se algum corpo de resposta ou mensagem de erro devolver o
 *  token, ele não chega ao terminal nem ao histórico do shell. */
const segredos = [tokenAgenda, tokenRetaguarda].filter((t) => t && t.length >= 6);
function censurar(texto) {
  let saida = String(texto);
  for (const segredo of segredos) saida = saida.split(segredo).join('«token oculto»');
  return saida;
}

/** Corpos de erro viram uma linha curta: o diagnóstico está no status, não no HTML. */
const resumir = (texto, limite = 220) => {
  const uma = censurar(texto).replace(/\s+/g, ' ').trim();
  return uma.length > limite ? `${uma.slice(0, limite)}…` : uma;
};

// ─── Argumentos e URL ────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const urlBruta = args[0] || V('PAINEL_API_URL');
const emailAtor = args[1] || V('PAINEL_ACTOR_EMAIL') || null;

/** Mesma regra do server/src/config.ts: host local é aquele em que o pacote não
 *  atravessa rede de terceiros — loopback (localhost, 127.0.0.0/8, ::1) e o
 *  mDNS *.local do ambiente de desenvolvimento. Só nele http:// não expõe nada. */
function ehHostLocal(hostname) {
  // `new URL('http://[::1]').hostname` devolve os colchetes junto.
  const host = String(hostname).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host.endsWith('.local') || host.endsWith('.localhost');
}

function normalizarUrl(bruta) {
  let texto = String(bruta).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(texto)) {
    // Sem esquema só dá pra ler o host fingindo um. Painel local roda em HTTP
    // puro, e assumir HTTPS em localhost só produziria um erro de TLS
    // incompreensível no lugar do diagnóstico de verdade. Fora de casa o padrão
    // é HTTPS: é por ali que o token vai viajar.
    let host = '';
    try {
      host = new URL(`https://${texto}`).hostname;
    } catch {
      // URL impossível: o catch de baixo devolve mensagem melhor que esta.
    }
    texto = `${ehHostLocal(host) ? 'http' : 'https'}://${texto}`;
  }
  let u;
  try {
    u = new URL(texto);
  } catch {
    return { erro: `"${bruta}" não é uma URL que dê pra entender.` };
  }
  let aviso = null;
  // Todo endpoint já começa com /api/. Base terminando em /api viraria /api/api.
  if (/\/api\/?$/i.test(u.pathname)) {
    aviso = 'tirei o /api do fim: os endereços testados já incluem /api/…';
    u.pathname = u.pathname.replace(/\/api\/?$/i, '');
  }
  const base = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  const ehLocal = ehHostLocal(u.hostname);
  return {
    base,
    origem: u.origin,
    aviso,
    ehLocal,
    // http:// em host remoto: as camadas que mandam token não podem rodar.
    inseguro: u.protocol === 'http:' && !ehLocal,
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Toda chamada é GET. Não existe caminho no arquivo que mande outro método. */
async function pegar(endereco, token) {
  const cabecalhos = { Accept: 'application/json' };
  if (token) cabecalhos.Authorization = `Bearer ${token}`;
  const r = await fetch(endereco, {
    method: 'GET',
    headers: cabecalhos,
    redirect: 'follow',
    signal: AbortSignal.timeout(TEMPO_LIMITE),
  });
  const texto = await r.text();
  const tipo = (r.headers.get('content-type') || '').toLowerCase();
  let json = null;
  if (texto) {
    try {
      json = JSON.parse(texto);
    } catch {
      json = null;
    }
  }
  return {
    status: r.status,
    tipo,
    texto,
    json,
    servidor: r.headers.get('server'),
    urlFinal: r.url,
    redirecionou: r.redirected,
    // O painel é uma API JSON; HTML aqui é sempre SPA ou página de erro.
    ehHtml: tipo.includes('text/html') || /^\s*<(!doctype|html)/i.test(texto),
  };
}

/** Traduz o erro cru do fetch para o que a pessoa precisa fazer.
 *  O fetch embrulha tudo em "fetch failed": o motivo real mora no .cause, e em
 *  host com IPv4+IPv6 vem um AggregateError com um erro por tentativa. */
function explicarFalhaDeRede(erro, ehLocal = false) {
  const causa = erro?.cause;
  const subErros = Array.isArray(causa?.errors) ? causa.errors : [];
  const codigo = causa?.code || erro?.code || subErros.find((e) => e?.code)?.code || '';
  const nome = erro?.name || '';
  if (nome === 'TimeoutError' || nome === 'AbortError' || codigo === 'ETIMEDOUT') {
    return ['o endereço não respondeu em 15s', 'Host errado, porta fechada ou firewall no caminho.'];
  }
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    return ['esse domínio não existe no DNS', 'Confira se digitou certo, ou se é um host interno que só resolve na VPN da empresa.'];
  }
  if (codigo === 'ECONNREFUSED') {
    return ['o host existe mas recusou a conexão', 'Nada escutando nessa porta. Se for localhost, o painel não está rodando.'];
  }
  if (codigo === 'ECONNRESET' || codigo === 'EPIPE') {
    return ['a conexão caiu no meio', 'Costuma ser proxy ou TLS incompatível.'];
  }
  if (String(codigo).includes('CERT') || String(codigo).includes('SSL') || codigo === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    // O conselho MUDA conforme o host, e a diferença é de segurança, não de
    // gosto: em host remoto, "tente http://" faria a pessoa mandar os dois
    // tokens do painel em texto claro pela rede corporativa — exatamente o que
    // este script deveria ajudar a evitar.
    if (ehLocal) {
      return [
        `o certificado HTTPS não confere (${codigo})`,
        'Em host local isso é esperado (certificado autoassinado, ou nenhum): repita a URL escrevendo http:// na frente — aqui o tráfego não sai da máquina.',
      ];
    }
    return [
      `o certificado HTTPS não confere (${codigo})`,
      'O problema é o CERTIFICADO, não o protocolo.\n' +
        '    NÃO caia pra http:// pra fugir disso: as camadas 3 a 5 mandam\n' +
        '    Authorization: Bearer <token>, e sem TLS o token vai em texto claro\n' +
        '    pela rede — quem estiver no caminho passa a marcar reunião no lugar\n' +
        '    da equipe. Saídas, nesta ordem:\n' +
        '      1. peça a quem mantém o painel um certificado válido pra este nome;\n' +
        '      2. se for certificado interno, instale a CA da empresa nesta máquina;\n' +
        '      3. rode este script de dentro da rede/VPN onde o certificado vale.',
    ];
  }
  // "fetch failed" sozinho não ajuda ninguém: o texto útil está na causa.
  const detalhe = causa?.message || subErros[0]?.message || erro?.message || 'falha de rede';
  return [censurar(detalhe), 'Erro de rede não catalogado — confira a URL, a porta e a conexão.'];
}

// ─── Datas ───────────────────────────────────────────────────────────────────

/** Próximo dia útil em horário local: a API recusa passado e fim de semana. */
function proximoDiaUtil() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ─── Cabeçalho ───────────────────────────────────────────────────────────────

p();
p(forte('VALIDADOR DA URL DO PAINEL') + '  \x1b[2m(somente leitura)\x1b[0m');
p();
p('  Este script só faz GET. Ele nunca cria reunião: no painel, um POST gera');
p('  link do Meet de verdade, dispara e-mail pro cliente, avisa no Slack e');
p('  ocupa a agenda de gente real.');
p();

if (!env) {
  p('  ' + meio(`não achei ${caminhoEnv}`));
  p('    Sem .env não há tokens pra testar — as camadas 3, 4 e 5 vão parar.');
  p('    Copie de server/.env.example e preencha PAINEL_EXT_AGENDA_TOKEN e');
  p('    PAINEL_RETAGUARDA_TOKEN.');
  p();
}

p('  ' + (tokenAgenda ? ok('token de agenda: presente') : nao('token de agenda: ausente')));
p('  ' + (tokenRetaguarda ? ok('token de retaguarda: presente') : nao('token de retaguarda: ausente')));
p();

if (!urlBruta) {
  p('  ' + nao('nenhuma URL pra testar'));
  p();
  p('    Passe na linha de comando:');
  p('      ' + forte('node scripts/testar-painel.mjs https://painel.exemplo.com.br seu.email@empresa.com'));
  p();
  p('    Ou preencha PAINEL_API_URL no server/.env e rode sem argumento.');
  p();
  process.exitCode = 1;
}

const alvo = urlBruta ? normalizarUrl(urlBruta) : null;

if (alvo && alvo.erro) {
  p('  ' + nao(alvo.erro));
  p('    Exemplo do que funciona: https://painel.exemplo.com.br');
  p();
  process.exitCode = 1;
}

// ─── Camadas ─────────────────────────────────────────────────────────────────

/** Estado que sobrevive entre camadas: o que a próxima precisa saber. */
let falhou = !urlBruta || Boolean(alvo?.erro);
let atorConfirmado = false;
/** Camadas que não falharam mas também não fecharam — o veredito não pode
 *  dizer "passou tudo" quando ficou coisa pra trás. */
const ressalvas = [];

if (!falhou && alvo) {
  const base = alvo.base;
  const url = (caminho) => `${base}${caminho}`;

  p(forte('  Alvo: ') + base);
  if (alvo.aviso) p('  ' + meio(alvo.aviso));
  if (alvo.inseguro) {
    p('  ' + nao('http:// em host remoto — as camadas 3 a 5 não vão rodar (motivo abaixo)'));
  }
  p();

  // ── Camada 1 — o endereço responde? ────────────────────────────────────────
  p(forte('CAMADA 1 — o endereço responde?'));
  p();
  let raiz1 = null;
  try {
    raiz1 = await pegar(`${base}/`, null);
    p('  ' + ok(`respondeu HTTP ${raiz1.status}${raiz1.servidor ? ` (Server: ${raiz1.servidor})` : ''}`));
    if (raiz1.redirecionou) p('    ' + meio(`redirecionou para ${raiz1.urlFinal}`));
  } catch (erro) {
    falhou = true;
    const [oQue, oQueFazer] = explicarFalhaDeRede(erro, alvo.ehLocal);
    p('  ' + nao(oQue));
    p(`    ${oQueFazer}`);
    p('    Pare aqui: sem host que responda, nada abaixo pode passar.');
  }
  p();

  // ── Camada 2 — /api/healthcheck devolve JSON? ──────────────────────────────
  if (!falhou) {
    p(forte('CAMADA 2 — GET /api/healthcheck devolve JSON?'));
    p();
    try {
      const r = await pegar(url('/api/healthcheck'), null);

      if (r.ehHtml) {
        falhou = true;
        p('  ' + nao(`HTTP ${r.status}, mas veio ${r.tipo || 'HTML'} em vez de JSON`));
        p();
        p('    ' + forte('ESSE ENDEREÇO SERVE UMA PÁGINA WEB, NÃO A API.'));
        p();
        p('    O painel deve estar em outro host, ou o rewrite do Vercel está');
        p('    engolindo /api/* e devolvendo o SPA pra qualquer caminho.');
        p();
        // Prova barata: se um caminho inventado responder igual, é catch-all.
        const isca = `/api/zzz-nao-existe-${Date.now().toString(36)}`;
        try {
          const teste = await pegar(url(isca), null);
          if (teste.ehHtml && teste.status < 400) {
            p('    ' + meio(`confirmado: ${isca} também devolve HTTP ${teste.status} em HTML.`));
            p('      Um caminho inventado só responde 200 se houver catch-all na frente.');
            p('      Não adianta insistir nesta URL — peça ao pessoal do painel o host');
            p('      real da API (costuma ser outro subdomínio, tipo api.… ou painel.…).');
          } else {
            p('    ' + meio(`${isca} devolveu HTTP ${teste.status} — o catch-all não pega tudo,`));
            p('      então /api/healthcheck talvez só não exista nesta versão do painel.');
          }
        } catch {
          p('    ' + meio('não consegui testar um caminho inventado pra confirmar o catch-all.'));
        }
      } else if (!r.json) {
        falhou = true;
        p('  ' + nao(`HTTP ${r.status}, e o corpo não é JSON válido (${r.tipo || 'sem content-type'})`));
        p(`    Corpo: ${resumir(r.texto) || '(vazio)'}`);
        p('    Isso não é a API do painel. Confirme o endereço com quem mantém o painel.');
      } else if (r.status >= 200 && r.status < 300) {
        p('  ' + ok(`HTTP ${r.status}, JSON — é uma API de verdade`));
        p(`    ${resumir(JSON.stringify(r.json), 160)}`);
      } else {
        // JSON fora do 2xx ainda prova que existe API aqui: seguimos, avisando.
        p('  ' + meio(`HTTP ${r.status}, mas em JSON — tem uma API aqui, só sem /api/healthcheck`));
        p(`    ${resumir(JSON.stringify(r.json), 160)}`);
        p('    Sigo pras próximas camadas: quem decide são os endpoints com token.');
      }
    } catch (erro) {
      falhou = true;
      const [oQue, oQueFazer] = explicarFalhaDeRede(erro, alvo.ehLocal);
      p('  ' + nao(`/api/healthcheck: ${oQue}`));
      p(`    ${oQueFazer}`);
    }
    p();
  }

  // ── Trava de TLS — daqui pra baixo toda chamada leva token ─────────────────
  // As camadas 1 e 2 rodam mesmo em http:// porque não mandam credencial
  // nenhuma: elas respondem "o host existe?" e "é uma API?", que é justamente o
  // diagnóstico que a pessoa veio buscar. Da 3 em diante muda de natureza — o
  // header Authorization entra na jogada, e sem TLS ele atravessa a rede
  // legível. Um script de diagnóstico não pode ser o motivo do vazamento.
  if (!falhou && alvo.inseguro) {
    falhou = true;
    p(forte('CAMADAS 3, 4 e 5 — RECUSADAS'));
    p();
    p('  ' + nao('não mando token do painel por http://'));
    p('    Essas camadas chamam /api/ext/agenda/me, /api/retaguarda/vendedores e');
    p('    /api/ext/agenda/available-slots, todas com Authorization: Bearer <token>.');
    p('    Sem TLS os DOIS tokens sairiam em texto claro pela rede corporativa, e');
    p('    quem os pegar passa a marcar reunião em nome da equipe — reunião de');
    p('    verdade, com e-mail pro cliente e agenda ocupada.');
    p();
    p('    Rode de novo com ' + forte('https://') + ' na frente do endereço.');
    p('    Se o HTTPS falhar por certificado, o conserto é o certificado — nunca');
    p('    voltar pra http://. Peça um certificado válido pra este nome, instale a');
    p('    CA da empresa nesta máquina, ou rode de dentro da rede/VPN onde ele vale.');
    p();
  }

  // ── Camada 3 — token de agenda ─────────────────────────────────────────────
  if (!falhou) {
    p(forte('CAMADA 3 — o token de agenda vale? (GET /api/ext/agenda/me)'));
    p();
    if (!tokenAgenda) {
      falhou = true;
      p('  ' + nao('PAINEL_EXT_AGENDA_TOKEN ausente no server/.env'));
      p('    É o EXT_AGENDA_TOKEN do painel. Sem ele a extensão não agenda nada.');
    } else {
      const consulta = emailAtor ? `?actor_email=${encodeURIComponent(emailAtor)}` : '';
      try {
        const r = await pegar(url(`/api/ext/agenda/me${consulta}`), tokenAgenda);

        if (r.ehHtml) {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status} em HTML — de novo a página web, não a API`));
          p('    Confirma o diagnóstico da camada 2: este host não serve /api/*.');
        } else if (r.status === 200) {
          atorConfirmado = Boolean(emailAtor);
          const j = r.json || {};
          const ator = j.actor || {};
          p('  ' + ok('HTTP 200 — token aceito e usuário reconhecido'));
          p(`    Quem: ${ator.name || '(sem nome)'} — papel: ${forte(ator.role || '?')}`);
          p(`    Identidade: ${j.identity_source === 'token' ? 'token pessoal (provada)' : `${j.identity_source || 'email'} (alegada pelo e-mail)`}`);
          const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
          if (caps.length) {
            p('    Pode agendar:');
            for (const c of caps) {
              const marca = c.allowed ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
              const cauda = c.allowed
                ? `→ ${c.assignment}${c.can_choose_assignee ? ' (escolhe o responsável)' : ''}`
                : `— ${c.reason || 'sem permissão'}`;
              p(`      ${marca} ${String(c.type).padEnd(14)} ${cauda}`);
            }
          } else {
            p('    ' + meio('a resposta não trouxe capabilities — confira o contrato do painel.'));
          }
        } else if (r.status === 401) {
          falhou = true;
          p('  ' + nao('HTTP 401 — token de agenda recusado'));
          p('    O PAINEL_EXT_AGENDA_TOKEN do .env não bate com o EXT_AGENDA_TOKEN do painel.');
          p('    Veja também se não trocou os dois tokens de lugar: o de retaguarda');
          p('    não abre esta porta.');
        } else if (r.status === 403) {
          falhou = true;
          p('  ' + nao('HTTP 403 — token válido, mas o acesso foi barrado'));
          p(`    ${resumir(r.texto)}`);
        } else if (r.status === 422) {
          if (emailAtor) {
            falhou = true;
            p('  ' + nao(`HTTP 422 — o token está certo, mas "${emailAtor}" não é usuário ativo do painel`));
            p('    O e-mail não existe lá, ou a pessoa foi desativada.');
            p('    Peça o e-mail exato de um usuário ativo e rode de novo com ele.');
          } else {
            // Sem actor_email o 422 é esperado — e já prova que o token passou.
            ressalvas.push('o papel e as permissões do atendente não foram conferidos (faltou o e-mail)');
            p('  ' + meio('HTTP 422 — o token PASSOU (não deu 401), mas falta dizer quem está agendando'));
            p('    Rode de novo com o e-mail pra ver papel e permissões:');
            p(`      ${forte(`node scripts/testar-painel.mjs ${base} seu.email@empresa.com`)}`);
          }
        } else if (r.status === 503) {
          falhou = true;
          p('  ' + nao('HTTP 503 — o painel está sem EXT_AGENDA_TOKEN configurado'));
          p('    Não é problema do seu .env: é do servidor do painel. Avise quem cuida dele.');
        } else {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status} — resposta que o contrato não prevê aqui`));
          p(`    ${resumir(r.texto)}`);
        }
      } catch (erro) {
        falhou = true;
        const [oQue, oQueFazer] = explicarFalhaDeRede(erro, alvo.ehLocal);
        p('  ' + nao(`/api/ext/agenda/me: ${oQue}`));
        p(`    ${oQueFazer}`);
      }
    }
    p();
  }

  // ── Camada 4 — token de retaguarda ─────────────────────────────────────────
  if (!falhou) {
    p(forte('CAMADA 4 — o token de retaguarda vale? (GET /api/retaguarda/vendedores)'));
    p();
    if (!tokenRetaguarda) {
      falhou = true;
      p('  ' + nao('PAINEL_RETAGUARDA_TOKEN ausente no server/.env'));
      p('    É o RETAGUARDA_INBOUND_TOKEN do painel.');
    } else {
      try {
        const r = await pegar(url('/api/retaguarda/vendedores'), tokenRetaguarda);
        // HTML vem ANTES do status, como na camada 3. Num deploy misto (só
        // algumas rotas /api/* são funções de verdade, o resto cai no catch-all
        // do SPA) esta rota devolve 200 + a home. Testando o status primeiro, o
        // 200 virava "✓ token aceito, 0 vendedor(es)" e o script mandava
        // preencher PAINEL_API_URL com um endereço que não serve a retaguarda.
        if (r.ehHtml) {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status} em ${r.tipo || 'HTML'} — este host não serve /api/retaguarda/*`));
          p('    As camadas 2 e 3 passaram, então parte da API existe aqui — mas esta');
          p('    rota caiu numa página web. Deploy pela metade ou prefixo diferente');
          p('    pra retaguarda. Confirme com quem mantém o painel.');
        } else if (r.status === 200) {
          // A resposta é `{ success, data: { vendedores: [...] } }` — DOIS
          // níveis. Medido contra o painel de verdade: a leitura antiga
          // (`data` sendo o array) imprimia "0 vendedor(es)" com 11 na
          // resposta, e isso parecia "ninguém ativo" em vez de "eu li errado".
          const d = r.json?.data;
          const lista = Array.isArray(d?.vendedores)
            ? d.vendedores
            : Array.isArray(r.json?.vendedores)
              ? r.json.vendedores
              : Array.isArray(d)
                ? d
                : Array.isArray(r.json)
                  ? r.json
                  : [];
          p('  ' + ok(`HTTP 200 — segundo token aceito, ${lista.length} vendedor(es) ativo(s)`));
          if (lista.length === 0) {
            p('    Lista vazia com 200: ou não há vendedor ativo, ou o formato mudou.');
          }
        } else if (r.status === 401) {
          falhou = true;
          p('  ' + nao('HTTP 401 — token de retaguarda recusado'));
          p('    São dois tokens diferentes e um não substitui o outro. Se a camada 3');
          p('    passou, o mais provável é que PAINEL_RETAGUARDA_TOKEN esteja com o');
          p('    valor errado (ou com o valor do token de agenda).');
        } else if (r.status === 403) {
          falhou = true;
          p('  ' + nao('HTTP 403 — token certo, IP barrado'));
          p('    A retaguarda tem allowlist de IP (RETAGUARDA_ALLOWED_IPS no painel).');
          p('    Peça pra incluírem o IP de saída desta máquina/servidor.');
        } else {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status}`));
          p(`    ${resumir(r.texto)}`);
        }
      } catch (erro) {
        falhou = true;
        const [oQue, oQueFazer] = explicarFalhaDeRede(erro, alvo.ehLocal);
        p('  ' + nao(`/api/retaguarda/vendedores: ${oQue}`));
        p(`    ${oQueFazer}`);
      }
    }
    p();
  }

  // ── Camada 5 — grade do próximo dia útil ───────────────────────────────────
  if (!falhou) {
    p(forte('CAMADA 5 — tem horário livre no próximo dia útil?'));
    p();
    if (!atorConfirmado) {
      ressalvas.push('a grade de horários não foi consultada (camada 5 pulada)');
      p('  ' + meio('pulada: a grade precisa de um actor_email confirmado na camada 3'));
      p('    Rode de novo passando o e-mail do atendente pra fechar o teste inteiro.');
    } else {
      const data = proximoDiaUtil();
      const consulta = `?type=apresentacao&date=${data}&actor_email=${encodeURIComponent(emailAtor)}`;
      try {
        const r = await pegar(url(`/api/ext/agenda/available-slots${consulta}`), tokenAgenda);
        // Mesma armadilha da camada 4: a grade em HTML tem `available_slots`
        // indefinido, viraria "0 horário(s) livre(s)" e passaria por dia cheio.
        if (r.ehHtml) {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status} em ${r.tipo || 'HTML'} — a grade veio como página web, não JSON`));
          p('    Sem esta rota a aba não tem horário pra oferecer. Confirme o');
          p('    endereço da API de agenda com quem mantém o painel.');
        } else if (r.status === 200) {
          const j = r.json || {};
          const livres = Array.isArray(j.available_slots) ? j.available_slots : [];
          const bloqueados = Array.isArray(j.blocked_slots) ? j.blocked_slots : [];
          p('  ' + ok(`HTTP 200 — ${j.date || data}: ${livres.length} horário(s) livre(s), ${bloqueados.length} bloqueado(s)`));
          if (livres.length) p(`    ${livres.slice(0, 12).join(', ')}${livres.length > 12 ? ' …' : ''}`);
          else p('    ' + meio('lista vazia não é erro: pode ser feriado ou ninguém disponível nesse dia.'));
          if (j.max_date) p(`    Agenda aberta até ${j.max_date} — não ofereça data além disso.`);
        } else if (r.status === 403) {
          p('  ' + meio('HTTP 403 — "apresentacao" não é permitido pra esse papel'));
          p('    Não é falha da URL: a camada 3 já provou o acesso. É regra de papel.');
        } else if (r.status === 422) {
          p('  ' + meio('HTTP 422 — a grade recusou os parâmetros'));
          p(`    ${resumir(r.texto)}`);
        } else {
          falhou = true;
          p('  ' + nao(`HTTP ${r.status}`));
          p(`    ${resumir(r.texto)}`);
        }
      } catch (erro) {
        falhou = true;
        const [oQue, oQueFazer] = explicarFalhaDeRede(erro, alvo.ehLocal);
        p('  ' + nao(`/api/ext/agenda/available-slots: ${oQue}`));
        p(`    ${oQueFazer}`);
      }
    }
    p();
  }

  // ── Veredito ───────────────────────────────────────────────────────────────
  p(forte('RESULTADO'));
  p();
  if (falhou) {
    p('  ' + nao('essa URL ainda não serve. Resolva a camada marcada com ✗ acima.'));
    p();
    p('    Enquanto isso, NÃO preencha PAINEL_API_URL: o servidor ia subir');
    p('    apontando pro lugar errado e falhar só na hora do atendimento.');
  } else {
    if (ressalvas.length) {
      p('  ' + ok('a URL está validada — é o painel, e os dois tokens foram aceitos.'));
      p();
      p('  ' + meio('mas ficou faltando:'));
      for (const r of ressalvas) p(`      - ${r}`);
    } else {
      p('  ' + ok('todas as camadas passaram — é o painel.'));
    }
    p();
    p('  Ponha esta linha no ' + forte('server/.env') + ':');
    p();
    p(`    ${forte(`PAINEL_API_URL=${base}`)}`);
    p();
    p('  Os dois tokens já estão lá e foram validados um a um.');
  }
  p();
}

// exitCode em vez de process.exit(): sair à força com sockets do fetch ainda
// abertos derruba o Node no Windows (assert do libuv).
process.exitCode = falhou ? 1 : 0;
