import { createLogger, errorMessage } from '../log.js';

/**
 * Cliente do PAINEL DE REUNIÕES (a plataforma comercial da empresa).
 *
 * Contrato real, tirado da collection do Postman ("Painel Implantação & CS —
 * Agendamento"), versionada em `docs/api-painel/`.
 *
 * Base: PAINEL_API_URL (local http://localhost:3000, produção o app)
 *
 *   GET  /api/healthcheck                              (público)
 *   GET  /api/ext/agenda/me?actor_email=               → papéis e capacidades
 *   GET  /api/ext/agenda/available-slots?type=&date=&actor_email=
 *        (migração exige também client_type=base|prospect)
 *   POST /api/ext/agenda/meetings                      → 201 { id, meet_link, … }
 *   POST /api/ext/agenda/meetings/{id}/transcript      → guarda a transcrição
 *   GET  /api/retaguarda/vendedores                    (token de retaguarda)
 *   GET  /api/retaguarda/migracao/status?cnpj=         (token de retaguarda)
 *
 * DUAS AUTENTICAÇÕES DIFERENTES, e trocar uma pela outra dá 401:
 *   - `/api/ext/agenda/*`  → Bearer PAINEL_EXT_AGENDA_TOKEN
 *   - `/api/retaguarda/*`  → Bearer PAINEL_RETAGUARDA_TOKEN
 *
 * QUEM É O ATENDENTE: `actor_email` viaja em toda chamada e é o que decide o
 * que a API permite. Como usamos o token COMPARTILHADO, a identidade é
 * *alegada*, não provada (`identity_source: "email"` no /me) — por isso o
 * e-mail vem do chatPro (localStorage `@chatpro:auth`) e é validado pelo /me
 * antes do formulário aparecer.
 *
 * REGRA QUE MOLDA A CLASSE: o painel fora do ar não pode derrubar o atendimento.
 * Leitura (me, slots, vendedores, status) nunca lança — devolve null/[] e loga.
 * ESCRITA é diferente: `criarReuniao` DEVOLVE o erro pra quem chamou, porque
 * dizer "marcada" sem ter marcado é pior que mostrar a falha.
 */

const log = createLogger('painel');

/** Leitura pode demorar; o clique não fica preso pra sempre. */
export const PAINEL_TIMEOUT_MS = 15_000;
/**
 * Erro de configuração é permanente: repetir a linha a cada chamada de cada aba
 * aberta enterraria o resto do log. Um lembrete por minuto e por operação já
 * chega pra quem está com o .env aberto arrumando.
 */
export const INTERVALO_AVISO_CONFIG_MS = 60_000;
/**
 * Teto curto pras chamadas que ficam NA FRENTE do atendente esperando a tela.
 * Um painel que aceita a conexão e não responde (firewall dropando, serviço
 * travado) faria a aba parecer congelada.
 */
export const PAINEL_TIMEOUT_CLIQUE_MS = 5_000;

/** Os quatro tipos que o time comercial marca. */
export const TIPOS_REUNIAO = ['apresentacao', 'migracao', 'implantacao', 'cs'] as const;
export type TipoReuniao = (typeof TIPOS_REUNIAO)[number];

export function ehTipoReuniao(valor: unknown): valor is TipoReuniao {
  return typeof valor === 'string' && (TIPOS_REUNIAO as readonly string[]).includes(valor);
}

/** Só a migração distingue cliente da base de prospect — pools diferentes. */
export type ClientType = 'base' | 'prospect';

/** Como a reunião é atribuída — vem do /me e muda o texto do botão. */
export type ModoAtribuicao = 'self' | 'round_robin' | 'explicit';

export interface CapacidadePainel {
  type: TipoReuniao;
  allowed: boolean;
  assignment: ModoAtribuicao;
  can_choose_assignee: boolean;
}

export interface IdentidadePainel {
  email: string;
  nome: string | null;
  papel: string | null;
  /** 'email' = identidade alegada (token compartilhado); 'token' = provada. */
  identitySource: string | null;
  capacidades: CapacidadePainel[];
}

export interface GradeHorarios {
  disponiveis: string[];
  bloqueados: string[];
  /** Último dia que o POST aceita. Não desenhar calendário além disto. */
  maxDate: string | null;
}

export interface PessoaPainel {
  email: string;
  nome: string;
}

/** O que o POST /meetings devolve quando dá 201. */
export interface ReuniaoCriada {
  id: string;
  meetLink: string | null;
  responsavelNome: string | null;
  responsavelEmail: string | null;
  assignmentMode: string | null;
}

export interface DadosNovaReuniao {
  type: TipoReuniao;
  actorEmail: string;
  clientName: string;
  companyName: string;
  phone: string;
  clientType: ClientType;
  scheduledDate: string;
  scheduledTime: string;
  cnpj?: string | undefined;
  instanceCode?: string | undefined;
  provedor?: string | undefined;
  vendedorEmail?: string | undefined;
  assigneeEmail?: string | undefined;
  csReason?: string | undefined;
  csPlan?: string | undefined;
  oficialPlan?: string | undefined;
  clientEmail?: string | undefined;
  skipEmail?: boolean | undefined;
}

/** Erro de escrita no painel — carrega o status pra quem chama decidir. */
export class PainelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detalhe: string = ''
  ) {
    super(message);
    this.name = 'PainelError';
  }
}

export interface PainelClientOptions {
  baseUrl: string | undefined;
  /** Token de /api/ext/agenda/* (EXT_AGENDA_TOKEN do painel). */
  extAgendaToken: string | undefined;
  /** Token de /api/retaguarda/* — opcional; sem ele a lista de vendedores fica vazia. */
  retaguardaToken?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injetável nos testes — 15 s de timeout real deixaria a suíte lenta. */
  timeoutMs?: number;
}

// ─── Censura de segredos ─────────────────────────────────────────────────────
//
// POR QUE ISTO EXISTE: o corpo de erro do painel entra no nosso log. Contra o
// painel de hoje isso é inofensivo (o 401 responde só "Token inválido."), mas o
// dia em que houver WAF, API gateway ou proxy de autenticação no caminho, o
// corpo do erro passa a ser JSON com o request ECOADO — headers inclusive. Aí o
// `Authorization: Bearer <token compartilhado>` iria parar no arquivo de log,
// que não tem o cuidado que um segredo merece. O scripts/testar-painel.mjs já
// tinha essa rede de segurança; o servidor não tinha.
//
// O objetivo é o TOKEN, não a mensagem: um log censurado a ponto de não dizer
// mais o que houve troca um problema por outro. Por isso só cai a máscara em
// cima do que tem forma de credencial.

/** O que sobra no lugar do segredo. Curto, pra não empurrar a mensagem pra fora. */
const MASCARA = '***';

/**
 * Segredo curto demais não é indexado: um token de 3 letras casaria com meio
 * texto e apagaria o log inteiro. Token de verdade tem dezenas de caracteres.
 */
const TAMANHO_MINIMO_SEGREDO = 6;

/** Pedaço de token grande o bastante pra reconhecer um eco truncado ou colado. */
const TAMANHO_TRECHO = 8;

/** `Bearer <algo>` em texto solto — o formato exato que um proxy ecoa. */
const RE_BEARER = /\b(bearer)(\s+)([A-Za-z0-9\-._~+/]{8,}={0,2})/gi;

/**
 * Campo de credencial em JSON: `"token":"…"`, `"authorization":"…"`,
 * `"access_token":"…"`, `"api_key":"…"`. O nome do campo é que decide — o valor
 * pode ser qualquer coisa, inclusive já mastigado pelo gateway.
 */
const RE_CAMPO_SENSIVEL =
  /("(?:[\w-]*(?:token|authorization|api[_-]?key|secret|password|senha))"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;

/** Sequência longa sem espaço: a cara de um token base64/hex jogado solto. */
const RE_SEQUENCIA_LONGA = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * Teto do corpo que a censura varre. Um gateway pode devolver megabytes de HTML;
 * varrer tudo pra depois cortar em 200 caracteres seria trabalho jogado fora.
 */
const LIMITE_LEITURA_CORPO = 4_000;

/**
 * "Bearer token ausente" não é credencial nenhuma — é a mensagem útil. Só vira
 * máscara o que tem cara de valor gerado: comprido, ou com dígito/símbolo/
 * mistura de caixa que palavra de mensagem não costuma ter.
 */
function pareceCredencial(valor: string): boolean {
  if (valor.length >= 20) return true;
  if (/\d/.test(valor)) return true;
  if (/[-._~+/]/.test(valor)) return true;
  return /[a-z]/.test(valor) && /[A-Z]/.test(valor);
}

/** Todos os pedaços de `TAMANHO_TRECHO` dos segredos, pra pegar eco parcial. */
function indexarTrechos(segredos: readonly string[]): Set<string> {
  const trechos = new Set<string>();
  for (const segredo of segredos) {
    for (let i = 0; i + TAMANHO_TRECHO <= segredo.length; i++) {
      trechos.add(segredo.slice(i, i + TAMANHO_TRECHO));
    }
  }
  return trechos;
}

function casaComAlgumTrecho(candidato: string, trechos: ReadonlySet<string>): boolean {
  for (let i = 0; i + TAMANHO_TRECHO <= candidato.length; i++) {
    if (trechos.has(candidato.slice(i, i + TAMANHO_TRECHO))) return true;
  }
  return false;
}

/**
 * Tira credencial de texto que veio de fora antes de ele virar log ou detalhe
 * de erro. Recebe os segredos conhecidos porque o valor mora na instância do
 * cliente; sem eles ainda vale a censura estrutural (Bearer, campos de token).
 *
 * Não é sanitização de saída nem substitui não logar: é a última rede antes do
 * arquivo de log, que costuma ser lido, copiado e colado por muita gente.
 */
export function censurar(texto: string, segredos: ReadonlyArray<string | undefined> = []): string {
  let saida = String(texto);

  // 1. O valor exato, primeiro e do maior pro menor: se um token contiver o
  //    outro, mascarar o menor antes deixaria o resto do maior visível.
  const conhecidos = segredos
    .filter((s): s is string => typeof s === 'string' && s.length >= TAMANHO_MINIMO_SEGREDO)
    .sort((a, b) => b.length - a.length);
  for (const segredo of conhecidos) saida = saida.split(segredo).join(MASCARA);

  // 2. `Bearer …` — pega até o token que a gente NÃO conhece (o de um serviço
  //    intermediário, por exemplo), sem comer a palavra que explica o erro.
  saida = saida.replace(RE_BEARER, (todo, palavra: string, espaco: string, valor: string) =>
    pareceCredencial(valor) ? `${palavra}${espaco}${MASCARA}` : todo
  );

  // 3. Campo cujo NOME diz que ali mora credencial.
  saida = saida.replace(RE_CAMPO_SENSIVEL, `$1${MASCARA}$3`);

  // 4. Sequência longa que casa com algum pedaço de um token configurado. A
  //    trava do "casa com" é o que impede a máscara de comer id de reunião,
  //    CNPJ ou hash de log — texto útil que também é longo e sem espaço.
  if (conhecidos.length > 0) {
    const trechos = indexarTrechos(conhecidos);
    saida = saida.replace(RE_SEQUENCIA_LONGA, (seq) =>
      casaComAlgumTrecho(seq, trechos) ? MASCARA : seq
    );
  }

  return saida;
}

// ─── Leitura defensiva ───────────────────────────────────────────────────────
// A resposta vem de fora e o contrato pode evoluir: nada de cast cego.

function objeto(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function texto(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function listaDeTextos(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Lê uma pessoa aceitando as duas grafias que a API mistura: a collection
 * mostra `responsavel.name`, mas campos de entrada são `*_email`. Aceitar
 * `nome` também custa nada e evita quebra boba se o painel mudar.
 */
function lerPessoa(v: unknown): PessoaPainel | null {
  const o = objeto(v);
  if (!o) return null;
  const email = texto(o.email) ?? texto(o.user_email);
  const nome = texto(o.name) ?? texto(o.nome) ?? email;
  return email && nome ? { email, nome } : null;
}

function lerCapacidades(v: unknown): CapacidadePainel[] {
  if (!Array.isArray(v)) return [];
  const out: CapacidadePainel[] = [];
  for (const item of v) {
    const o = objeto(item);
    const tipo = texto(o?.type);
    if (!o || !ehTipoReuniao(tipo)) continue;
    const atribuicao = texto(o.assignment);
    out.push({
      type: tipo,
      allowed: o.allowed === true,
      assignment:
        atribuicao === 'self' || atribuicao === 'round_robin' || atribuicao === 'explicit'
          ? atribuicao
          : 'round_robin',
      can_choose_assignee: o.can_choose_assignee === true,
    });
  }
  return out;
}

// ─── "isto é uma API ou um site?" ────────────────────────────────────────────
//
// Um SPA hospedado com catch-all (Vercel, Netlify, nginx `try_files`) devolve
// 200 + o HTML da home pra QUALQUER caminho, inclusive /api/naoexiste-xyz. Foi
// exatamente o que aconteceu com PAINEL_API_URL=https://app.chatpro.com.br:
// toda chamada "dava certo" (HTTP 200) e só estourava dentro do .json(), com um
// "Unexpected token '<'" que virava `falha em me: ...` no log. Quem configurou
// ficava sem saber que o problema era o ENDEREÇO — a única coisa que precisava
// saber. Por isso o content-type é checado ANTES de tentar interpretar o corpo.

type FormatoResposta = 'json' | 'nao-json' | 'indefinido';

function formatoDaResposta(resposta: Response): FormatoResposta {
  const bruto = (resposta.headers.get('content-type') ?? '').trim().toLowerCase();
  // Sem content-type não dá pra acusar ninguém: segue o fluxo antigo e deixa o
  // parse decidir (204, respostas vazias de proxy).
  if (bruto === '') return 'indefinido';
  // Pega application/json, application/problem+json e text/json; text/html não.
  return bruto.includes('json') ? 'json' : 'nao-json';
}

function mimeDaResposta(resposta: Response): string {
  const primeiro = (resposta.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  return primeiro ? primeiro : 'sem content-type';
}

/** O caminho sem query: o log não precisa (nem deve) carregar o e-mail. */
function semQuery(caminho: string): string {
  const corte = caminho.indexOf('?');
  return corte === -1 ? caminho : caminho.slice(0, corte);
}

function mensagemUrlDeSite(caminho: string, resposta: Response): string {
  const status = resposta.status === 200 ? '' : ` com HTTP ${resposta.status}`;
  return (
    'PAINEL_API_URL aponta pra uma página web, não pra a API do painel ' +
    `(respondeu ${mimeDaResposta(resposta)}${status} em ${semQuery(caminho)}). Confira o endereço.`
  );
}

function mensagemRotaInexistente(caminho: string): string {
  return (
    `o painel devolveu 404 em JSON para ${semQuery(caminho)}: tem uma API nesse endereço, ` +
    'mas essa rota não existe nela. Confira o caminho/prefixo de PAINEL_API_URL.'
  );
}

/**
 * Anexa o `error` que o painel mandou, quando mandou. Nunca ecoa credencial:
 * este texto vai pro navegador dentro do diagnóstico, e quem escreveu o corpo
 * do erro pode ser um gateway que ecoa o request inteiro.
 */
async function motivoDoErro(
  resposta: Response,
  limpar: (texto: string) => string
): Promise<string> {
  const bruto: unknown = await resposta.json().catch(() => undefined);
  const erro = texto(objeto(bruto)?.error);
  // Censura ANTES de cortar: cortar primeiro partiria o token ao meio e a busca
  // pelo valor exato não o reconheceria mais.
  return erro ? `: ${limpar(erro).slice(0, 200)}` : '.';
}

/**
 * Corpo que não vamos ler precisa ser descartado: no undici a resposta segura a
 * conexão do pool até alguém consumir ou cancelar o stream.
 */
function descartarCorpo(resposta: Response): void {
  void resposta.body?.cancel().catch(() => undefined);
}

/** O que `diagnosticar()` sabe distinguir. */
export type ProblemaPainel =
  /** PAINEL_API_URL não foi definida — integração desligada de propósito. */
  | 'sem-url'
  /** URL definida, mas sem PAINEL_EXT_AGENDA_TOKEN nada de agenda passa. */
  | 'sem-token'
  /** O endereço serve um site (o SPA), não a API. É o caso do app.chatpro. */
  | 'html-em-vez-de-json'
  /** Existe API ali e ela fala JSON, mas a rota não é essa (prefixo errado). */
  | 'rota-inexistente'
  /** Não deu pra falar com o painel: DNS, recusa, timeout, 5xx. */
  | 'nao-alcancavel'
  /** 401/403 — token errado, ou trocaram o de agenda pelo de retaguarda. */
  | 'token-invalido'
  /** 422 — o painel responde, o token vale, mas o e-mail não é usuário ativo. */
  | 'usuario-desconhecido';

export interface DiagnosticoPainel {
  /** `true` = nada errado foi encontrado até onde deu pra checar. */
  ok: boolean;
  problema?: ProblemaPainel;
  /** Frase pronta pra quem está configurando. NUNCA carrega token. */
  detalhe?: string;
}

// ─── Entrega da transcrição ──────────────────────────────────────────────────

/**
 * Como terminou a tentativa de subir a transcrição.
 *
 * Por que não é um booleano: o POST /transcript NÃO tem Idempotency-Key. Se ele
 * estourar o timeout, o painel pode ter salvo o texto e só a resposta ter se
 * perdido — e aí um "false" faria a gente reenviar e gravar a transcrição do
 * cliente EM DOBRO no registro da reunião. Quem chama precisa distinguir:
 *
 *   'enviado'  → o painel confirmou. Nunca mais mandar.
 *   'recusado' → o painel respondeu dizendo não (4xx claro), ou nem chegou a
 *                sair daqui. É CERTEZA de que nada foi salvo: reenviar é seguro.
 *   'incerto'  → timeout, queda de rede, 5xx. PODE estar lá. Reenvio só com
 *                confirmação de gente, depois de conferir no painel.
 */
export type ResultadoTranscricao =
  | { estado: 'enviado' }
  | { estado: 'recusado'; motivo: string }
  | { estado: 'incerto'; motivo: string };

/**
 * O painel recebeu, entendeu e disse não? Só aí temos certeza de que ele não
 * guardou nada: 400 (payload inválido), 401/403 (token), 404 (reunião não
 * existe lá), 409, 422 (actor_email não é usuário ativo).
 *
 * 408, 425 e 429 são 4xx mas NÃO são recusa de conteúdo — e 5xx pode vir de um
 * proxy que desistiu depois de o painel já ter gravado. Na dúvida, incerto: um
 * reenvio manual a mais custa um clique; uma transcrição duplicada é dado
 * sensível de cliente registrado duas vezes, e ninguém desfaz isso daqui.
 */
function ehRecusaDefinitiva(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

// ─── CNPJ ────────────────────────────────────────────────────────────────────

export function normalizarCnpj(bruto: string): string {
  return bruto.replace(/\D/g, '');
}

/**
 * Valida CNPJ pelos dígitos verificadores. O painel usa CNPJ como chave de
 * consulta (checklist de migração, onboarding); um dígito trocado não devolve
 * "não achei", devolve os dados de OUTRA empresa.
 */
export function validarCnpj(bruto: string): boolean {
  const n = normalizarCnpj(bruto);
  if (n.length !== 14) return false;
  // Todos iguais passam no cálculo mas não existem.
  if (/^(\d)\1{13}$/.test(n)) return false;

  const digito = (base: string, pesos: number[]): number => {
    const soma = pesos.reduce((acc, peso, i) => acc + Number(base[i]) * peso, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = digito(n, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digito(n, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(n[12]) === d1 && Number(n[13]) === d2;
}

// ─── Razão social a partir do CNPJ ───────────────────────────────────────────
//
// Digitar o CNPJ tem que trazer a razão social sozinho — o atendente está com o
// cliente na linha, não com o cartão CNPJ na mão.
//
// TRÊS FONTES, nesta ordem:
//   1. O PAINEL (/api/retaguarda/migracao/status). É o CADASTRO DELES: se a
//      empresa está lá, é aquele nome que vai aparecer no registro da reunião,
//      então é ele que o formulário tem que mostrar. De quebra, a mesma resposta
//      já diz se existe checklist de migração ativo.
//   2. BrasilAPI (pública, sem chave). Só entra quando o painel não conhece o
//      CNPJ — prospect que ainda não virou checklist, que é o caso comum.
//   3. cnpj.ws (pública, sem chave). RESERVA, e só quando a BrasilAPI LIMITOU.
//
// POR QUE A RESERVA E AS RETENTATIVAS EXISTEM: a BrasilAPI limita POR IP, e o
// escritório inteiro sai por um IP só. Quando a cota fecha ela responde 403 (às
// vezes 429) e volta a responder 200 na tentativa seguinte, segundos depois. O
// código antigo tratava qualquer resposta não-ok como "não achei", guardava
// essa falha no cache e o campo NUNCA mais preenchia naquela sessão — foi
// exatamente o "a razão social não está puxando do CNPJ" que o atendente
// reportou. Um tropeço de cota não pode virar falha permanente.

/** Base da consulta pública de CNPJ. Sem chave, sem cadastro, sem header. */
export const BRASILAPI_URL = 'https://brasilapi.com.br/api/cnpj/v1';

/**
 * Reserva pública, com OUTRA forma de resposta:
 * `{ razao_social, estabelecimento: { nome_fantasia, ddd1, telefone1 } }`.
 *
 * Vale a pena porque as duas contam cota por IP em janelas diferentes: a chance
 * de as duas fecharem no mesmo instante é bem menor que a de uma fechar.
 */
export const CNPJWS_URL = 'https://publica.cnpj.ws/cnpj';

/**
 * Teto de UMA tentativa numa fonte pública. Ela é ENFEITE do formulário:
 * preenche um campo que o atendente também sabe preencher na mão. Curto de
 * propósito — melhor o campo vazio do que a tela parecendo travada esperando
 * serviço de terceiro.
 */
export const BRASILAPI_TIMEOUT_MS = 5_000;

/**
 * Teto do CONJUNTO: as três tentativas na BrasilAPI, as esperas entre elas e a
 * ida à reserva somadas. Tem gente com o cliente na linha olhando o campo — o
 * orçamento é o que garante que retentar não vira tela congelada. Cada tentativa
 * recebe o que ainda sobra dele, e quando não sobra nada a busca para.
 */
export const CNPJ_ORCAMENTO_MS = 4_000;

/**
 * Espera entre as retentativas do LIMITE, uma por retentativa (logo: 2 extras).
 * Cresce porque a primeira serve pra janela de cota virar e a segunda pra dar
 * tempo de a fonte respirar; somadas cabem no orçamento com folga pra reserva.
 */
export const ESPERAS_LIMITE_MS: readonly number[] = [400, 1200];

/**
 * Sucesso vale um DIA: razão social não muda entre a manhã e a tarde, e o campo
 * dispara a cada digitação (máscara, colar, apagar e redigitar o último dígito).
 * Sem cache longo, um preenchimento só viraria várias consultas pelo MESMO CNPJ.
 */
export const CACHE_CNPJ_MS = 24 * 60 * 60 * 1000;

/**
 * "Esse CNPJ não existe" (404) é resposta FIRME: a fonte olhou e não achou.
 * Uma hora de silêncio é justo — o que muda nesse prazo é o cadastro do painel,
 * e empresa nova na Receita não aparece em minutos.
 */
export const CACHE_CNPJ_INEXISTENTE_MS = 60 * 60 * 1000;

/**
 * Fonte fora do ar, timeout, 5xx: ninguém disse nada, nem que existe nem que
 * não. O painel pode voltar e o checklist pode ter sido criado agora há pouco —
 * um minuto já mata a enxurrada de digitação sem congelar o erro.
 */
export const CACHE_CNPJ_FALHA_MS = 60_000;

/**
 * LIMITE de cota. O prazo mais curto de todos DE PROPÓSITO: guardar por muito
 * tempo o "estou limitado" transforma um tropeço de segundos numa falha que
 * dura a sessão inteira. Trinta segundos seguram a enxurrada de teclas e já
 * deixam a próxima digitação tentar de novo.
 */
export const CACHE_CNPJ_LIMITE_MS = 30_000;

/** Teto do cache — é um servidor que fica dias no ar, não pode crescer sem fim. */
export const CACHE_CNPJ_MAX = 500;

export interface DadosCnpj {
  razaoSocial: string;
  nomeFantasia?: string;
  telefone?: string;
  /** De onde veio o nome — a tela avisa quando não é o cadastro do painel. */
  fonte: 'painel' | 'brasilapi';
  /**
   * O painel CONFIRMOU checklist de migração ativo pra este CNPJ.
   *
   * `false` também cobre "não deu pra confirmar" (painel fora do ar, sem token
   * de retaguarda): as duas terminam igual pra quem está na tela — não dá pra
   * garantir que a migração vai ser aceita, e o POST devolveria 422 explicando.
   */
  temChecklist: boolean;
}

/** O que uma fonte pública sabe dizer. Sem `fonte`/`temChecklist`: isso é nosso. */
interface DadosPublicos {
  razaoSocial: string;
  nomeFantasia?: string;
  telefone?: string;
}

/**
 * POR QUE "não veio nada" tem três sabores: cada um merece um prazo de cache
 * diferente, e confundi-los foi o defeito. `limite` ainda pede retentativa;
 * `nao-existe` não pede nenhuma.
 */
type MotivoSemDados =
  /** 404: a fonte olhou e disse que não existe. Não adianta insistir. */
  | 'nao-existe'
  /** 403/429: cota por IP fechada. Volta sozinho em segundos — insista. */
  | 'limite'
  /** Timeout, DNS, 5xx, corpo estranho: ninguém disse nada. */
  | 'indisponivel';

/** Resposta de UMA fonte pública, já interpretada. */
type RespostaFonte = { estado: 'achou'; dados: DadosPublicos } | { estado: MotivoSemDados };

/** O que `consultarCnpj` apurou — o motivo é o que decide o prazo do cache. */
interface ApuracaoCnpj {
  dados: DadosCnpj | null;
  /** Só faz sentido quando `dados` é null. */
  motivo?: MotivoSemDados;
  /**
   * O que o PAINEL disse sobre o checklist, mesmo quando nenhuma fonte soube a
   * razão social. Sobe separado de `dados` porque a aba precisa dele pra não
   * consultar o mesmo endpoint duas vezes na mesma digitação.
   */
  temChecklist?: boolean | null;
}

/**
 * 403 e 429 são LIMITE de cota (a BrasilAPI usa 403 pra isso, não só 429); 404
 * é "não existe". O resto — 5xx, 502 de CDN, corpo que não é JSON — é a fonte
 * de mau humor: não sabemos nada, e um prazo curto de cache basta.
 */
function classificarStatus(status: number): MotivoSemDados {
  if (status === 403 || status === 429) return 'limite';
  if (status === 404) return 'nao-existe';
  return 'indisponivel';
}

/** Espera simples pro recuo entre retentativas. */
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Telefone de cadastro em formato aproveitável: só dígitos. A BrasilAPI manda
 * `ddd_telefone_1` como "1130001000", às vezes com máscara, às vezes vazio.
 * Fora da faixa brasileira (10 a 13 dígitos com o 55) não vale a pena mandar
 * pro formulário — atrapalha mais do que ajuda.
 */
function lerTelefone(v: unknown): string | undefined {
  const bruto = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const digitos = bruto.replace(/\D/g, '');
  return digitos.length >= 10 && digitos.length <= 13 ? digitos : undefined;
}

/** Últimos 4 dígitos bastam pro diagnóstico — CNPJ inteiro é dado de cliente. */
function fimDoCnpj(cnpjNormalizado: string): string {
  return `…${cnpjNormalizado.slice(-4)}`;
}

/**
 * Mensagem de erro de rede pode carregar a URL que falhou — e a URL da BrasilAPI
 * tem o CNPJ inteiro dentro. Troca pelo final antes de virar log.
 */
function semCnpj(texto: string, cnpjNormalizado: string): string {
  return texto.split(cnpjNormalizado).join(fimDoCnpj(cnpjNormalizado));
}

/** Forma da BrasilAPI: tudo na raiz, telefone já com DDD em `ddd_telefone_1`. */
function lerBrasilApi(bruto: unknown): DadosPublicos | null {
  const o = objeto(bruto);
  const razaoSocial = texto(o?.razao_social);
  if (!razaoSocial) return null;
  const nomeFantasia = texto(o?.nome_fantasia);
  const telefone = lerTelefone(o?.ddd_telefone_1);
  return {
    razaoSocial,
    ...(nomeFantasia ? { nomeFantasia } : {}),
    ...(telefone ? { telefone } : {}),
  };
}

/**
 * Forma da cnpj.ws: a razão social fica na raiz, mas o resto mora em
 * `estabelecimento`, e o telefone vem PARTIDO em `ddd1` + `telefone1` — juntar
 * é o que devolve o mesmo formato de dígitos que o formulário já sabe usar.
 */
function lerCnpjWs(bruto: unknown): DadosPublicos | null {
  const o = objeto(bruto);
  const razaoSocial = texto(o?.razao_social);
  if (!razaoSocial) return null;
  const est = objeto(o?.estabelecimento);
  const nomeFantasia = texto(est?.nome_fantasia);
  const ddd = texto(est?.ddd1) ?? '';
  const numero = texto(est?.telefone1) ?? '';
  const telefone = lerTelefone(`${ddd}${numero}`);
  return {
    razaoSocial,
    ...(nomeFantasia ? { nomeFantasia } : {}),
    ...(telefone ? { telefone } : {}),
  };
}

/**
 * Quanto tempo esta resposta merece ficar guardada. É AQUI que mora o conserto:
 * antes, todo "não veio nada" ficava o mesmo tanto, e um limite de cota de
 * poucos segundos calava o campo pelo prazo de um "não existe".
 */
function validadeDoCache(apurado: ApuracaoCnpj): number {
  if (apurado.dados) return CACHE_CNPJ_MS;
  if (apurado.motivo === 'nao-existe') return CACHE_CNPJ_INEXISTENTE_MS;
  if (apurado.motivo === 'limite') return CACHE_CNPJ_LIMITE_MS;
  return CACHE_CNPJ_FALHA_MS;
}

export class PainelClient {
  private readonly baseUrl: string | undefined;
  private readonly extAgendaToken: string | undefined;
  private readonly retaguardaToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** operação → instante do último aviso de configuração (anti-enxurrada). */
  private readonly ultimoAviso = new Map<string, number>();
  /**
   * CNPJ normalizado → o que as fontes disseram, com validade. Fica NA
   * INSTÂNCIA, não em módulo: o servidor tem um cliente só, e cache global
   * vazaria entre instâncias nos testes.
   */
  private readonly cacheCnpj = new Map<
    string,
    { expiraEm: number; dados: DadosCnpj | null; temChecklist?: boolean | null }
  >();
  /** Os segredos que este cliente manda pra rede — e que não podem voltar no log. */
  private readonly segredos: readonly string[];

  constructor(options: PainelClientOptions) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : undefined;
    this.extAgendaToken = options.extAgendaToken;
    this.retaguardaToken = options.retaguardaToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PAINEL_TIMEOUT_MS;
    this.segredos = [options.extAgendaToken, options.retaguardaToken].filter(
      (t): t is string => typeof t === 'string' && t !== ''
    );
  }

  /** Nada que veio do outro lado vira log ou mensagem sem passar por aqui. */
  private censurar(texto: string): string {
    return censurar(texto, this.segredos);
  }

  /**
   * Corpo de resposta pronto pro log: censurado e curto, nessa ordem. Invertido
   * (cortar e depois censurar) um token que começasse perto do limite ficaria
   * pela metade no texto — irreconhecível pela censura e ainda assim vazado.
   *
   * O corte grosso antes da censura é só pra não varrer um corpo de megabytes.
   */
  private resumirCorpo(bruto: string, limite = 200): string {
    return this.censurar(bruto.slice(0, LIMITE_LEITURA_CORPO)).slice(0, limite);
  }

  /** Sem URL ou sem token de agenda o cliente fica inerte, e isso é legítimo. */
  estaConfigurado(): boolean {
    return Boolean(this.baseUrl && this.extAgendaToken);
  }

  /**
   * Diz O QUE está errado na configuração do painel, em vez de deixar todo
   * defeito virar o mesmo sintoma ("nenhum horário, nenhum vendedor, nada").
   *
   * Vai em dois passos porque cada um responde uma pergunta diferente:
   *   1. /api/healthcheck (público) → "tem uma API neste endereço?"
   *   2. /api/ext/agenda/me         → "o token vale? este e-mail é usuário?"
   *
   * Sem `actorEmail` o diagnóstico PARA no passo 1 e diz isso: sem um e-mail
   * de verdade o /me devolveria 422 e a gente acusaria o token à toa.
   */
  async diagnosticar(actorEmail?: string): Promise<DiagnosticoPainel> {
    if (!this.baseUrl) {
      return {
        ok: false,
        problema: 'sem-url',
        detalhe: 'PAINEL_API_URL não está definida no .env do servidor — a integração está desligada.',
      };
    }
    // Tem gente esperando esta resposta numa tela: usa o teto curto.
    const timeoutMs = Math.min(this.timeoutMs, PAINEL_TIMEOUT_CLIQUE_MS);

    const saude = await this.sondar('/api/healthcheck', this.extAgendaToken, timeoutMs);
    if ('erro' in saude) return saude.erro;
    if (!saude.resposta.ok) {
      descartarCorpo(saude.resposta);
      return {
        ok: false,
        problema: 'nao-alcancavel',
        detalhe: `o endereço respondeu, mas /api/healthcheck deu HTTP ${saude.resposta.status}.`,
      };
    }
    descartarCorpo(saude.resposta);

    if (!this.extAgendaToken) {
      return {
        ok: false,
        problema: 'sem-token',
        detalhe:
          'o painel respondeu ao healthcheck, mas PAINEL_EXT_AGENDA_TOKEN não está definida — ' +
          'nenhuma chamada de agenda passa sem ela.',
      };
    }

    const email = (actorEmail ?? '').trim();
    if (!email.includes('@')) {
      return {
        ok: true,
        detalhe:
          'só o /api/healthcheck foi verificado: sem um actor_email válido não dá pra testar ' +
          'o token de agenda nem o cadastro do atendente.',
      };
    }

    const caminhoMe = `/api/ext/agenda/me?actor_email=${encodeURIComponent(email)}`;
    const me = await this.sondar(caminhoMe, this.extAgendaToken, timeoutMs);
    if ('erro' in me) return me.erro;
    const resposta = me.resposta;

    if (resposta.status === 401 || resposta.status === 403) {
      descartarCorpo(resposta);
      return {
        ok: false,
        problema: 'token-invalido',
        detalhe:
          `o painel recusou o token de agenda (HTTP ${resposta.status}). Confira ` +
          'PAINEL_EXT_AGENDA_TOKEN — o token de retaguarda não vale em /api/ext/agenda/*.',
      };
    }
    if (resposta.status === 422) {
      return {
        ok: false,
        problema: 'usuario-desconhecido',
        detalhe: `o painel respondeu e aceitou o token, mas não reconhece ${email} como usuário ativo${await motivoDoErro(resposta, (t) => this.censurar(t))}`,
      };
    }
    if (!resposta.ok) {
      descartarCorpo(resposta);
      return {
        ok: false,
        problema: 'nao-alcancavel',
        detalhe: `/api/ext/agenda/me respondeu HTTP ${resposta.status}.`,
      };
    }
    const dados: unknown = await resposta.json().catch(() => undefined);
    if (!objeto(dados)) {
      return {
        ok: false,
        problema: 'html-em-vez-de-json',
        detalhe:
          'o /api/ext/agenda/me respondeu 200 com content-type de JSON, mas o corpo não é um ' +
          'objeto — esse endereço provavelmente não é a API do painel.',
      };
    }
    return { ok: true, detalhe: `painel respondendo e ${email} reconhecido.` };
  }

  /**
   * GET cru pro diagnóstico: devolve a resposta ou já um veredito. Diferente do
   * `ler()`, não engole nada — quem chamou o diagnóstico quer o defeito.
   */
  private async sondar(
    caminho: string,
    token: string | undefined,
    timeoutMs: number
  ): Promise<{ resposta: Response } | { erro: DiagnosticoPainel }> {
    let resposta: Response;
    try {
      resposta = await this.pedir('GET', caminho, { token, timeoutMs });
    } catch (err) {
      return {
        erro: {
          ok: false,
          problema: 'nao-alcancavel',
          detalhe: `não deu pra falar com o painel em ${semQuery(caminho)}: ${this.censurar(errorMessage(err))}`,
        },
      };
    }
    if (formatoDaResposta(resposta) === 'nao-json') {
      // Serve pro 200 do catch-all e pro 404 de site sem catch-all: nos dois
      // casos o que está do outro lado é um servidor de páginas.
      descartarCorpo(resposta);
      return {
        erro: {
          ok: false,
          problema: 'html-em-vez-de-json',
          detalhe: mensagemUrlDeSite(caminho, resposta),
        },
      };
    }
    // 404 do painel NÃO é sempre erro de configuração: o contrato documenta
    // 404 como resposta NORMAL de negócio em
    // `GET /api/retaguarda/migracao/status` — "não existe checklist para esse
    // CNPJ". Gritar "confira PAINEL_API_URL" nesse caso manda a pessoa mexer
    // numa configuração que está certa.
    //
    // A diferença está no corpo: com `error`, quem falou foi o painel; sem
    // nada, é o 404 do framework e aí sim a rota não existe nessa base.
    if (resposta.status === 404) {
      const bruto: unknown = await resposta.json().catch(() => undefined);
      // Com `error` no corpo, quem respondeu foi o PAINEL — é uma API viva
      // dizendo "não achei esse recurso", não uma rota inexistente. O
      // diagnóstico só olha o status, então devolver a resposta basta.
      if (texto(objeto(bruto)?.error)) return { resposta };
      return {
        erro: { ok: false, problema: 'rota-inexistente', detalhe: mensagemRotaInexistente(caminho) },
      };
    }
    return { resposta };
  }

  /**
   * Quem é o atendente e o que ele pode marcar. É a PRIMEIRA chamada da aba:
   * o formulário é desenhado a partir daqui, em vez de oferecer tudo e deixar
   * o 403 aparecer com os campos já preenchidos.
   *
   * `null` = não deu pra saber (painel fora, token errado, e-mail desconhecido).
   */
  async me(actorEmail: string): Promise<IdentidadePainel | null> {
    const dados = await this.ler(
      'me',
      `/api/ext/agenda/me?actor_email=${encodeURIComponent(actorEmail)}`,
      PAINEL_TIMEOUT_CLIQUE_MS
    );
    const o = objeto(dados);
    if (!o) return null;
    // A resposta pode vir embrulhada em `data` — aceitar as duas formas evita
    // uma quebra boba num campo que não muda nada pra gente.
    const raiz = objeto(o.data) ?? o;
    // O painel devolve `actor`. Aceitar `user` também não custa nada e cobre
    // uma renomeação futura sem quebrar a tela do atendente.
    const usuario = objeto(raiz.actor) ?? objeto(raiz.user) ?? raiz;
    const email = texto(usuario.email) ?? actorEmail;
    return {
      email,
      nome: texto(usuario.name) ?? texto(usuario.nome) ?? null,
      papel: texto(usuario.role) ?? texto(usuario.papel) ?? null,
      identitySource: texto(raiz.identity_source) ?? null,
      capacidades: lerCapacidades(raiz.capabilities),
    };
  }

  /**
   * Grade de um dia. Lista vazia NÃO é erro (feriado, fim de semana, ninguém
   * livre) — e é uma fotografia: entre consultar e confirmar alguém pode ocupar
   * o horário, e aí o POST devolve 409. Isso é esperado, não falha.
   */
  async horarios(options: {
    tipo: TipoReuniao;
    data: string;
    actorEmail: string;
    clientType?: ClientType | undefined;
  }): Promise<GradeHorarios | null> {
    const params = new URLSearchParams({
      type: options.tipo,
      date: options.data,
      actor_email: options.actorEmail,
    });
    // Migração EXIGE client_type (sem ele a API devolve 422), mas os outros
    // tipos também o aceitam — medido contra produção. Mandar sempre que a
    // aba souber é o que garante que a grade consultada seja a MESMA fila em
    // que a reunião vai ser criada: base e prospect são pools distintos por
    // contrato, e hoje as grades coincidem só porque estão configurados igual.
    // Consultar um pool e marcar no outro faria a pessoa escolher um horário
    // "livre" e levar 409 no fim.
    if (options.clientType) {
      params.set('client_type', options.clientType);
    }
    const dados = await this.ler(
      'available-slots',
      `/api/ext/agenda/available-slots?${params.toString()}`,
      PAINEL_TIMEOUT_CLIQUE_MS
    );
    const o = objeto(dados);
    if (!o) return null;
    const raiz = objeto(o.data) ?? o;
    return {
      disponiveis: listaDeTextos(raiz.available_slots),
      bloqueados: listaDeTextos(raiz.blocked_slots),
      maxDate: texto(raiz.max_date) ?? null,
    };
  }

  /**
   * Cria a reunião NO PAINEL. É ele que gera o link do Meet, cria o evento na
   * agenda do responsável, manda o `.ics` e avisa no Slack.
   *
   * Diferente do resto da classe, este método LANÇA: se a reunião não foi
   * criada, o atendente precisa saber. Repetir o POST depois de um 201 criaria
   * reunião duplicada — e-mail que não saiu não é motivo pra repetir.
   */
  async criarReuniao(dados: DadosNovaReuniao): Promise<ReuniaoCriada> {
    if (!this.baseUrl || !this.extAgendaToken) {
      throw new PainelError('O painel de reuniões não está configurado no servidor.', 0);
    }

    // Data e hora vão SEPARADAS e em horário local BR, de propósito: mandar um
    // instante UTC de um navegador em outro fuso marcaria a reunião na hora
    // errada. O servidor deriva o UTC.
    const corpo: Record<string, unknown> = {
      type: dados.type,
      actor_email: dados.actorEmail,
      client_name: dados.clientName,
      company_name: dados.companyName,
      phone: dados.phone,
      client_type: dados.clientType,
      scheduled_date: dados.scheduledDate,
      scheduled_time: dados.scheduledTime,
    };
    const opcionais: [string, unknown][] = [
      ['cnpj', dados.cnpj],
      ['instance_code', dados.instanceCode],
      ['provedor', dados.provedor],
      ['vendedor_email', dados.vendedorEmail],
      ['assignee_email', dados.assigneeEmail],
      ['cs_reason', dados.csReason],
      ['cs_plan', dados.csPlan],
      ['oficial_plan', dados.oficialPlan],
      ['client_email', dados.clientEmail],
      ['skip_email', dados.skipEmail],
    ];
    for (const [chave, valor] of opcionais) {
      if (valor !== undefined && valor !== '') corpo[chave] = valor;
    }

    const resposta = await this.pedir('POST', '/api/ext/agenda/meetings', {
      corpo,
      token: this.extAgendaToken,
      timeoutMs: this.timeoutMs,
    });

    const caminho = '/api/ext/agenda/meetings';
    const formato = formatoDaResposta(resposta);
    if (formato === 'nao-json') {
      descartarCorpo(resposta);
      // Um SPA devolvendo 200 aqui é o pior cenário: PARECE que deu certo e
      // nenhuma reunião foi criada. Repetir o POST não resolve enquanto a URL
      // estiver errada, então a mensagem tem que ser sobre a URL.
      if (resposta.ok) {
        const mensagem = mensagemUrlDeSite(caminho, resposta);
        this.avisarConfiguracao('meetings', mensagem);
        throw new PainelError(mensagem, 0, `HTTP ${resposta.status} ${mimeDaResposta(resposta)}`);
      }
      throw new PainelError(
        `O painel respondeu HTTP ${resposta.status} em ${mimeDaResposta(resposta)}, não JSON.`,
        resposta.status
      );
    }

    const bruto: unknown = await resposta.json().catch(() => undefined);
    if (!resposta.ok) {
      const doPainel = texto(objeto(bruto)?.error);
      // 404 SEM `error` no corpo é o 404 do framework: a rota não existe nessa
      // base. Com `error`, quem está falando é o painel (assignee inexistente,
      // por exemplo) e a mensagem dele vale mais que o nosso palpite.
      if (resposta.status === 404 && !doPainel) {
        const mensagem = mensagemRotaInexistente(caminho);
        this.avisarConfiguracao('meetings', mensagem);
        throw new PainelError(mensagem, 404);
      }
      // A mensagem do painel vai pra tela do atendente e o corpo cru vai pro
      // `.detalhe`. Se quem respondeu foi um gateway ecoando o request, os dois
      // carregam o Authorization — então os dois passam pela censura.
      const erro = doPainel ? this.censurar(doPainel) : `HTTP ${resposta.status}`;
      throw new PainelError(
        erro,
        resposta.status,
        this.resumirCorpo(JSON.stringify(bruto ?? ''), 400)
      );
    }

    const o = objeto(bruto) ?? {};
    const raiz = objeto(o.data) ?? o;
    const id = texto(raiz.id);
    if (!id) {
      // Sem id não dá pra mandar a transcrição depois — e a reunião FOI criada.
      // Melhor gritar aqui do que descobrir no fim da reunião.
      throw new PainelError(
        'O painel criou a reunião mas não devolveu o id. Confira no painel antes de marcar de novo.',
        resposta.status
      );
    }
    const responsavel = lerPessoa(raiz.responsavel);
    return {
      id,
      meetLink: texto(raiz.meet_link) ?? null,
      responsavelNome: responsavel?.nome ?? null,
      responsavelEmail: responsavel?.email ?? null,
      assignmentMode: texto(raiz.assignment_mode) ?? null,
    };
  }

  /**
   * Manda a transcrição pro painel — é lá que ela mora.
   *
   * Melhor esforço: nunca lança. A transcrição continua salva aqui e o painel
   * tem o botão de reenvio; derrubar a fila do Recall porque o painel piscou
   * seria pior.
   *
   * Mas o resultado NÃO é um booleano — ver `ResultadoTranscricao`. Um POST que
   * estourou o timeout pode ter sido salvo do outro lado, e tratar isso como
   * "falhou" foi o que duplicou transcrição no registro da reunião.
   */
  async enviarTranscricao(options: {
    meetingId: string;
    actorEmail: string;
    texto: string;
    idioma?: string;
  }): Promise<ResultadoTranscricao> {
    if (!this.baseUrl || !this.extAgendaToken) {
      // Nada chegou a sair daqui: é certeza de que o painel não guardou nada.
      return { estado: 'recusado', motivo: 'painel não configurado no servidor' };
    }
    const caminho = `/api/ext/agenda/meetings/${encodeURIComponent(options.meetingId)}/transcript`;

    let resposta: Response;
    try {
      resposta = await this.pedir('POST', caminho, {
        corpo: {
          actor_email: options.actorEmail,
          language_code: options.idioma ?? 'pt-BR',
          text: options.texto,
        },
        token: this.extAgendaToken,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      // Timeout do abort e falha de rede caem aqui, e os dois são AMBÍGUOS: o
      // corpo pode ter chegado inteiro e só a resposta ter se perdido — o
      // painel grava primeiro e responde depois. Ninguém retenta isto sozinho.
      const motivo = this.censurar(errorMessage(err));
      log.error(
        `não deu pra confirmar a entrega da transcrição da reunião ${options.meetingId} ao ` +
          `painel (${motivo}). Estado INCERTO: ela PODE já estar lá — não reenvie sem conferir.`
      );
      return { estado: 'incerto', motivo };
    }

    // 200 com HTML é o SPA no lugar da API: o painel nem chegou a ver isto.
    if (resposta.ok && formatoDaResposta(resposta) === 'nao-json') {
      descartarCorpo(resposta);
      const mensagem = mensagemUrlDeSite(caminho, resposta);
      this.avisarConfiguracao('transcript', mensagem);
      return { estado: 'recusado', motivo: mensagem };
    }
    if (resposta.ok) {
      descartarCorpo(resposta);
      // Nunca logamos o texto — transcrição é dado sensível de cliente (LGPD).
      log.info(`transcrição da reunião ${options.meetingId} entregue ao painel.`);
      return { estado: 'enviado' };
    }

    const detalhe = await resposta.text().catch(() => '');
    const motivo = `HTTP ${resposta.status} ${this.resumirCorpo(detalhe)}`.trim();
    if (ehRecusaDefinitiva(resposta.status)) {
      log.warn(`painel recusou a transcrição da reunião ${options.meetingId}: ${motivo}`);
      return { estado: 'recusado', motivo };
    }
    log.error(
      `entrega da transcrição da reunião ${options.meetingId} ficou INCERTA (${motivo}) — ` +
        'o painel pode ter salvo antes de a resposta se perder; não reenvie sem conferir.'
    );
    return { estado: 'incerto', motivo };
  }

  /**
   * Gera o checklist de onboarding do CNPJ (`POST /api/retaguarda/migracao/link`).
   *
   * POR QUE ISTO EXISTE: o painel recusa marcar migração sem checklist ativo —
   * "Gere o link do onboarding antes de agendar". Só que, no fluxo real do
   * time, esse link é gerado DURANTE a migração, não antes. Mandar o atendente
   * sair da tela pra criar o checklist em outro lugar quebra o atendimento por
   * uma regra de ordem que não é a dele.
   *
   * Então a aba passa a oferecer gerar aqui mesmo, num clique explícito. É
   * ESCRITA e cria registro de verdade: nunca acontece sozinho.
   *
   * Quando já existe um checklist, a API reaproveita (responde 200 em vez de
   * 201) — então clicar duas vezes não duplica nada.
   */
  async gerarLinkDeMigracao(entrada: {
    cnpj: string;
    vendedorEmail: string;
    instanceCode: string;
  }): Promise<
    | { ok: true; publicUrl: string | null; razaoSocial: string | null }
    | { ok: false; motivo: string }
  > {
    if (!this.baseUrl || !this.retaguardaToken) {
      return { ok: false, motivo: 'A retaguarda do painel não está configurada no servidor.' };
    }
    if (!validarCnpj(entrada.cnpj)) return { ok: false, motivo: 'CNPJ inválido.' };

    try {
      const resposta = await this.pedir('POST', '/api/retaguarda/migracao/link', {
        corpo: {
          cnpj: normalizarCnpj(entrada.cnpj),
          vendedor_email: entrada.vendedorEmail,
          instance_code: entrada.instanceCode,
        },
        token: this.retaguardaToken,
        timeoutMs: this.timeoutMs,
      });
      const bruto: unknown = await resposta.json().catch(() => undefined);
      if (!resposta.ok) {
        const erro = texto(objeto(bruto)?.error) ?? `HTTP ${resposta.status}`;
        return { ok: false, motivo: this.censurar(erro) };
      }
      const dentro = objeto(objeto(bruto)?.data) ?? objeto(bruto) ?? {};
      // O checklist recém-criado invalida o que estava guardado.
      this.cacheCnpj.delete(normalizarCnpj(entrada.cnpj));
      log.info(`checklist de migração gerado para …${normalizarCnpj(entrada.cnpj).slice(-4)}.`);
      return {
        ok: true,
        publicUrl: texto(dentro.public_url) ?? null,
        razaoSocial: texto(dentro.razao_social) ?? null,
      };
    } catch (err) {
      return { ok: false, motivo: this.censurar(errorMessage(err)) };
    }
  }

  /** Vendedores pro seletor da apresentação. `[]` = sem token de retaguarda. */
  async vendedores(): Promise<PessoaPainel[]> {
    if (!this.retaguardaToken) return [];
    const dados = await this.ler(
      'vendedores',
      '/api/retaguarda/vendedores',
      PAINEL_TIMEOUT_CLIQUE_MS,
      this.retaguardaToken
    );
    // O painel responde `{ success, data: { vendedores: [...] } }` — dois
    // níveis, não um. Medido contra o painel de verdade; a suposição anterior
    // (`data` sendo o array) devolvia lista vazia em silêncio, e o seletor de
    // vendedor apareceria sempre vazio sem ninguém entender por quê.
    const o = objeto(dados);
    const dentro = objeto(o?.data);
    const lista = Array.isArray(dados)
      ? dados
      : Array.isArray(dentro?.vendedores)
        ? dentro.vendedores
        : Array.isArray(o?.vendedores)
          ? o.vendedores
          : Array.isArray(o?.data)
            ? o.data
            : [];
    return lista.map(lerPessoa).filter((p): p is PessoaPainel => p !== null);
  }

  /**
   * Em que pé está o checklist de migração daquele CNPJ. A migração só pode ser
   * marcada com checklist ativo — sem isso o POST devolve 422, e é melhor o
   * atendente saber disso ANTES de preencher o formulário inteiro.
   */
  async statusMigracao(cnpj: string): Promise<Record<string, unknown> | null> {
    if (!this.retaguardaToken || !validarCnpj(cnpj)) return null;
    const dados = await this.ler(
      'migracao/status',
      `/api/retaguarda/migracao/status?cnpj=${encodeURIComponent(normalizarCnpj(cnpj))}`,
      PAINEL_TIMEOUT_CLIQUE_MS,
      this.retaguardaToken
    );
    const o = objeto(dados);
    return o ? (objeto(o.data) ?? o) : null;
  }

  /**
   * Razão social (e o que mais der) a partir do CNPJ, pro formulário se
   * preencher sozinho. NUNCA lança: é conveniência, e conveniência que quebra a
   * tela é pior que campo vazio.
   *
   * `null` = ninguém soube dizer. Pra tela isso termina igual a "fonte fora do
   * ar": o atendente digita o nome na mão, como fazia antes.
   */
  async dadosDoCnpj(cnpj: string): Promise<DadosCnpj | null> {
    return (await this.apurarCnpj(cnpj)).dados;
  }

  /**
   * Como , mas devolve TAMBÉM o que se sabe do checklist quando
   * nenhuma fonte soube a razão social.
   *
   * Existe porque o  já foi apurado no /migracao/status, e
   * escondê-lo dentro de  fazia a aba disparar uma SEGUNDA consulta ao
   * mesmo endpoint, pro mesmo CNPJ, na mesma digitação — justo quando o painel
   * já está lento (é o caso em que a fonte pública falhou).
   */
  async apurarCnpj(cnpj: string): Promise<{ dados: DadosCnpj | null; temChecklist: boolean | null }> {
    const n = normalizarCnpj(cnpj);
    // CNPJ com dígito verificador errado não vira consulta nenhuma: o painel
    // devolveria a empresa ERRADA e a BrasilAPI levaria um pedido à toa a cada
    // tecla enquanto a pessoa ainda está digitando.
    if (!validarCnpj(n)) return { dados: null, temChecklist: null };

    const emCache = this.cacheCnpj.get(n);
    if (emCache && emCache.expiraEm > Date.now()) {
      return { dados: emCache.dados, temChecklist: emCache.temChecklist ?? null };
    }

    const apurado = await this.consultarCnpj(n);
    this.guardarNoCache(n, apurado);
    return { dados: apurado.dados, temChecklist: apurado.temChecklist ?? null };
  }

  /** As fontes, na ordem: painel primeiro (é o cadastro), públicas depois. */
  private async consultarCnpj(n: string): Promise<ApuracaoCnpj> {
    const doPainel = await this.statusMigracao(n);
    // Sem resposta do painel a gente NÃO SABE se há checklist — e "não sei"
    // vira `false`, porque prometer migração que o POST vai recusar é pior.
    const temChecklist = doPainel !== null && doPainel.found !== false;
    const razaoDoPainel = texto(doPainel?.razao_social) ?? texto(doPainel?.razaoSocial);

    if (razaoDoPainel) {
      log.info(
        `razão social de ${fimDoCnpj(n)} veio do painel ` +
          `(checklist ${temChecklist ? 'ativo' : 'ausente'}).`
      );
      const nomeFantasia = texto(doPainel?.nome_fantasia) ?? texto(doPainel?.nomeFantasia);
      const telefone = lerTelefone(doPainel?.telefone ?? doPainel?.phone);
      return {
        dados: {
          razaoSocial: razaoDoPainel,
          ...(nomeFantasia ? { nomeFantasia } : {}),
          ...(telefone ? { telefone } : {}),
          fonte: 'painel',
          temChecklist,
        },
      };
    }

    const publico = await this.consultarFontesPublicas(n);
    if (publico.estado !== 'achou') {
      // O motivo sobe junto porque é ele que decide quanto tempo este "não" vai
      // ficar no cache. Sem ele, um limite de cota de 5 s calaria o campo pelo
      // prazo de um "não existe".
      log.info(
        `nenhuma fonte soube a razão social de ${fimDoCnpj(n)} (${publico.estado}) — ` +
          'o campo fica pro atendente.'
      );
      return { dados: null, motivo: publico.estado, temChecklist };
    }
    // `temChecklist` continua vindo do PAINEL, não das fontes públicas: a
    // Receita não sabe nada sobre o checklist de migração da nossa retaguarda.
    //
    // `fonte: 'brasilapi'` vale também pro que veio da reserva: pra tela esse
    // campo responde UMA pergunta — "este nome é do nosso cadastro ou de
    // consulta pública?" — e as duas fontes públicas respondem igual. Inventar
    // um terceiro valor mudaria o contrato com a extensão sem mudar o que ela
    // faz. Qual das duas respondeu está no log.
    return { dados: { ...publico.dados, fonte: 'brasilapi', temChecklist } };
  }

  /**
   * As fontes PÚBLICAS, com orçamento de tempo próprio.
   *
   * A BrasilAPI é a preferida (dado mais completo). Quando ela LIMITA, e só
   * nesse caso, vale insistir: recuo crescente e, se ainda assim ela não abrir,
   * a reserva. 404 e fonte fora do ar não ganham retentativa nenhuma — insistir
   * ali só faria o atendente esperar por um "não" que já veio.
   */
  private async consultarFontesPublicas(n: string): Promise<RespostaFonte> {
    const fim = Date.now() + CNPJ_ORCAMENTO_MS;

    let resultado: RespostaFonte = { estado: 'indisponivel' };
    for (let tentativa = 0; ; tentativa++) {
      resultado = await this.buscarNaFonte('BrasilAPI', `${BRASILAPI_URL}/${n}`, n, fim, lerBrasilApi);
      if (resultado.estado !== 'limite') break;
      const espera = this.esperaDoLimite(tentativa);
      // Sem mais retentativas previstas, ou sem orçamento pra esperar e ainda
      // pedir: parar aqui é melhor que estourar o tempo do clique.
      if (espera === undefined || fim - Date.now() <= espera) break;
      log.debug(
        `BrasilAPI limitou a consulta do CNPJ ${fimDoCnpj(n)}; ` +
          `nova tentativa em ${espera} ms (${tentativa + 1}ª).`
      );
      await esperar(espera);
    }
    if (resultado.estado !== 'limite') return resultado;

    // Só o limite chega aqui: a reserva existe pra contornar cota de IP, não
    // pra dar segunda opinião sobre um CNPJ que a Receita já disse não existir.
    const reserva = await this.buscarNaFonte('cnpj.ws', `${CNPJWS_URL}/${n}`, n, fim, lerCnpjWs);
    if (reserva.estado === 'achou') return reserva;
    // A reserva falhando NÃO vira 'nao-existe': quem sabia responder estava
    // limitado, então continuamos sem saber — e 'limite' é o prazo curto de
    // cache, o que faz a próxima digitação tentar de novo em vez de desistir.
    return resultado;
  }

  /**
   * Quanto esperar antes da retentativa `tentativa` (0 = a primeira delas).
   * `undefined` = acabaram as retentativas.
   *
   * O `timeoutMs` da instância também limita: nos testes ele é injetado curto,
   * e 1,6 s de sono real por caso deixaria a suíte lenta à toa. Em produção ele
   * vale 15 s e não muda nada — e um recuo maior que o teto de uma tentativa
   * não faria sentido de qualquer forma.
   */
  private esperaDoLimite(tentativa: number): number | undefined {
    const espera = ESPERAS_LIMITE_MS[tentativa];
    return espera === undefined ? undefined : Math.min(espera, this.timeoutMs);
  }

  /**
   * Uma tentativa numa fonte PÚBLICA de CNPJ.
   *
   * Fica fora do `pedir()` de propósito, e isto não é estilo: o `pedir()` cola a
   * base do painel na URL e — pior — manda `Authorization: Bearer <token>`. São
   * outros hosts; o token é NOSSO e não tem por que sair de casa. Aqui só vai
   * `Accept`.
   */
  private async buscarNaFonte(
    nome: string,
    url: string,
    n: string,
    fimDoOrcamento: number,
    ler: (bruto: unknown) => DadosPublicos | null
  ): Promise<RespostaFonte> {
    const restante = fimDoOrcamento - Date.now();
    if (restante <= 0) {
      log.debug(`sem orçamento de tempo pra consultar a ${nome} pelo CNPJ ${fimDoCnpj(n)}.`);
      return { estado: 'indisponivel' };
    }
    // Em teste o timeoutMs injetado é pequeno; em produção vale o teto curto da
    // fonte pública, e nunca mais do que ainda sobra do orçamento.
    const timeoutMs = Math.min(this.timeoutMs, BRASILAPI_TIMEOUT_MS, restante);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resposta = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!resposta.ok) {
        descartarCorpo(resposta);
        const motivo = classificarStatus(resposta.status);
        // Nada disto é defeito nosso (CNPJ novo, cota do IP, fonte oscilando):
        // fica em debug pra não poluir o log do atendimento.
        log.debug(
          `${nome} respondeu HTTP ${resposta.status} (${motivo}) pro CNPJ ${fimDoCnpj(n)}.`
        );
        return { estado: motivo };
      }
      const bruto: unknown = await resposta.json().catch(() => undefined);
      const dados = ler(bruto);
      // 200 sem razão social: a fonte respondeu e não tem o nome. Vale como
      // "não existe" — insistir devolveria o mesmo corpo vazio.
      if (!dados) return { estado: 'nao-existe' };
      // A razão social NÃO entra no log — é dado de cliente, igual ao CNPJ.
      // Saber a origem já basta pra explicar de onde o campo se preencheu.
      log.info(`razão social do CNPJ ${fimDoCnpj(n)} veio da ${nome}.`);
      return { estado: 'achou', dados };
    } catch (err) {
      // Timeout, DNS, rede caída: a tela segue viva sem a razão social. A
      // mensagem do erro costuma trazer a URL, e a URL tem o CNPJ inteiro.
      log.warn(
        `${nome} não respondeu pelo CNPJ ${fimDoCnpj(n)}: ` +
          semCnpj(this.censurar(errorMessage(err)), n)
      );
      return { estado: 'indisponivel' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Grava no cache com o prazo que o RESULTADO merece — ver CACHE_CNPJ_LIMITE_MS. */
  private guardarNoCache(cnpj: string, apurado: ApuracaoCnpj): void {
    // Map guarda ordem de inserção: o mais antigo é o primeiro da fila e sai
    // quando o teto estoura. Reinserir move a chave pro fim, então o delete
    // antes do set mantém a ordem honesta.
    this.cacheCnpj.delete(cnpj);
    if (this.cacheCnpj.size >= CACHE_CNPJ_MAX) {
      const maisAntigo = this.cacheCnpj.keys().next();
      if (!maisAntigo.done) this.cacheCnpj.delete(maisAntigo.value);
    }
    this.cacheCnpj.set(cnpj, {
      expiraEm: Date.now() + validadeDoCache(apurado),
      dados: apurado.dados,
    });
  }

  // ─── Encanamento ───────────────────────────────────────────────────────────

  /** GET que nunca lança: leitura falhando não pode derrubar o atendimento. */
  private async ler(
    operacao: string,
    caminho: string,
    timeoutMs?: number,
    token?: string
  ): Promise<unknown | undefined> {
    if (!this.baseUrl) {
      log.debug(`PAINEL_API_URL vazia — ${operacao} pulada (integração desligada).`);
      return undefined;
    }
    const usar = token ?? this.extAgendaToken;
    if (!usar) {
      log.debug(`sem token — ${operacao} pulada.`);
      return undefined;
    }
    try {
      const resposta = await this.pedir('GET', caminho, {
        token: usar,
        timeoutMs: timeoutMs ?? this.timeoutMs,
      });
      const formato = formatoDaResposta(resposta);
      // 200 + HTML é o sinal mais claro de endereço errado: nenhum painel
      // responde a grade de horários com uma página. Nem tenta o .json().
      if (resposta.ok && formato === 'nao-json') {
        descartarCorpo(resposta);
        this.avisarConfiguracao(operacao, mensagemUrlDeSite(caminho, resposta));
        return undefined;
      }
      if (!resposta.ok) {
        // 404 EM JSON é outra história: existe API ali. Mas nem todo 404 é rota
        // errada — o contrato do painel usa 404 como resposta NORMAL de
        // negócio em `GET /api/retaguarda/migracao/status` ("não existe
        // checklist para esse CNPJ"). Gritar "confira PAINEL_API_URL" nesse
        // caso manda a pessoa mexer numa configuração que está certa, e todo
        // CNPJ sem checklist viraria um alarme falso.
        //
        // A diferença está no corpo: com `error`, quem falou foi o painel.
        if (resposta.status === 404 && formato !== 'nao-json') {
          const bruto: unknown = await resposta.json().catch(() => undefined);
          const corpo = objeto(bruto);
          const doPainel = texto(corpo?.error);
          // `found:false` é a OUTRA cara do "não achei" de negócio: é assim que
          // o /migracao/status responde CNPJ sem checklist, e sem `error`
          // nenhum. Tratar isso como rota errada faria cada prospect digitado
          // gritar "confira PAINEL_API_URL" — mandando consertar o que está bom.
          if (doPainel || (corpo && 'found' in corpo)) {
            log.debug(
              `painel respondeu 404 em ${operacao}: ${doPainel ? this.censurar(doPainel) : 'não encontrado'}`
            );
            return undefined;
          }
          this.avisarConfiguracao(operacao, mensagemRotaInexistente(caminho));
          return undefined;
        }
        if (formato === 'nao-json') {
          // Página de erro de proxy/gateway: despejar 200 caracteres de HTML no
          // log não ajuda; o status e o mime já contam a história.
          descartarCorpo(resposta);
          log.warn(
            `painel respondeu HTTP ${resposta.status} em ${operacao} com ${mimeDaResposta(resposta)}, não JSON.`
          );
          return undefined;
        }
        const detalhe = await resposta.text().catch(() => '');
        log.warn(
          `painel respondeu HTTP ${resposta.status} em ${operacao}: ${this.resumirCorpo(detalhe)}`
        );
        return undefined;
      }
      return (await resposta.json()) as unknown;
    } catch (err) {
      log.warn(`falha em ${operacao}: ${this.censurar(errorMessage(err))}`);
      return undefined;
    }
  }

  /**
   * Erro de CONFIGURAÇÃO (não de disponibilidade): grita alto, mas no máximo
   * uma vez por minuto por operação. Sem a trava, uma aba aberta faria dezenas
   * de linhas idênticas por minuto e o operador pararia de ler o log.
   */
  private avisarConfiguracao(operacao: string, mensagem: string): void {
    const agora = Date.now();
    const anterior = this.ultimoAviso.get(operacao);
    if (anterior !== undefined && agora - anterior < INTERVALO_AVISO_CONFIG_MS) return;
    this.ultimoAviso.set(operacao, agora);
    log.error(`${mensagem} (visto em ${operacao})`);
  }

  private async pedir(
    metodo: 'GET' | 'POST',
    caminho: string,
    options: { corpo?: unknown; token: string | undefined; timeoutMs: number }
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      // O token vai no header e NUNCA no log — é credencial compartilhada.
      // Sem token o header some: /api/healthcheck é público e o diagnóstico
      // precisa poder bater nele antes de ter credencial nenhuma.
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (options.corpo !== undefined) headers['Content-Type'] = 'application/json';
      return await this.fetchImpl(`${this.baseUrl}${caminho}`, {
        method: metodo,
        headers,
        ...(options.corpo !== undefined ? { body: JSON.stringify(options.corpo) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new PainelError(
          `O painel não respondeu em ${Math.round(options.timeoutMs / 1000)} s.`,
          0
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
