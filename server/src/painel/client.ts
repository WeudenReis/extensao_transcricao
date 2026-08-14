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

export class PainelClient {
  private readonly baseUrl: string | undefined;
  private readonly extAgendaToken: string | undefined;
  private readonly retaguardaToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PainelClientOptions) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : undefined;
    this.extAgendaToken = options.extAgendaToken;
    this.retaguardaToken = options.retaguardaToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PAINEL_TIMEOUT_MS;
  }

  /** Sem URL ou sem token de agenda o cliente fica inerte, e isso é legítimo. */
  estaConfigurado(): boolean {
    return Boolean(this.baseUrl && this.extAgendaToken);
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
    const usuario = objeto(raiz.user) ?? raiz;
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
    // Migração é o ÚNICO tipo que exige client_type: base e prospect são
    // atendidos por pools diferentes. Sem o parâmetro a API devolve 422.
    if (options.tipo === 'migracao' && options.clientType) {
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

    const bruto: unknown = await resposta.json().catch(() => undefined);
    if (!resposta.ok) {
      const erro = texto(objeto(bruto)?.error) ?? `HTTP ${resposta.status}`;
      throw new PainelError(erro, resposta.status, JSON.stringify(bruto ?? '').slice(0, 400));
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
   * Melhor esforço: devolve `false` em vez de lançar. A transcrição continua
   * salva aqui e o painel tem o botão de reenvio; derrubar a fila do Recall
   * porque o painel piscou seria pior.
   */
  async enviarTranscricao(options: {
    meetingId: string;
    actorEmail: string;
    texto: string;
    idioma?: string;
  }): Promise<boolean> {
    if (!this.baseUrl || !this.extAgendaToken) return false;
    try {
      const resposta = await this.pedir(
        'POST',
        `/api/ext/agenda/meetings/${encodeURIComponent(options.meetingId)}/transcript`,
        {
          corpo: {
            actor_email: options.actorEmail,
            language_code: options.idioma ?? 'pt-BR',
            text: options.texto,
          },
          token: this.extAgendaToken,
          timeoutMs: this.timeoutMs,
        }
      );
      if (!resposta.ok) {
        const detalhe = await resposta.text().catch(() => '');
        log.warn(
          `painel recusou a transcrição da reunião ${options.meetingId}: ` +
            `HTTP ${resposta.status} ${detalhe.slice(0, 200)}`
        );
        return false;
      }
      // Nunca logamos o texto — transcrição é dado sensível de cliente (LGPD).
      log.info(`transcrição da reunião ${options.meetingId} entregue ao painel.`);
      return true;
    } catch (err) {
      log.warn(`falha ao entregar transcrição ao painel: ${errorMessage(err)}`);
      return false;
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
    const o = objeto(dados);
    const lista = Array.isArray(dados) ? dados : Array.isArray(o?.data) ? o.data : [];
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
      if (!resposta.ok) {
        const detalhe = await resposta.text().catch(() => '');
        log.warn(`painel respondeu HTTP ${resposta.status} em ${operacao}: ${detalhe.slice(0, 200)}`);
        return undefined;
      }
      return (await resposta.json()) as unknown;
    } catch (err) {
      log.warn(`falha em ${operacao}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private async pedir(
    metodo: 'GET' | 'POST',
    caminho: string,
    options: { corpo?: unknown; token: string; timeoutMs: number }
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers: Record<string, string> = {
        // O token vai no header e NUNCA no log — é credencial compartilhada.
        Authorization: `Bearer ${options.token}`,
      };
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
