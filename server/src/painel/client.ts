import { createLogger, errorMessage } from '../log.js';

/**
 * Adapter do PAINEL INTERNO (a plataforma comercial da empresa).
 *
 * ⚠️ CONTRATO PROVISÓRIO — ajustar quando a API interna for passada.
 * A URL e os endpoints abaixo são PRESUMIDOS; o usuário ainda vai entregar o
 * contrato real (paths, formato de resposta, header de auth). Este arquivo é o
 * ponto ÚNICO a mexer nesse dia — mesma estratégia do VoreoClient e do
 * ChatproClient deste repositório.
 *
 * Endpoints presumidos (todos relativos a PAINEL_API_URL):
 *   GET  /disponibilidade?inicio=&fim=   → [{ inicio, fim }]           (PRESUMIDO)
 *   POST /distribuicao { tipo }          → { email, nome }             (PRESUMIDO)
 *   GET  /vendedores                     → [{ email, nome }]           (PRESUMIDO)
 *   GET  /onboarding?cnpj=               → { nome, instancia, telefone } (PRESUMIDO)
 *   POST /reunioes { ...dados }          → 2xx                         (PRESUMIDO)
 *
 * Regra que molda TODOS os métodos: o painel interno caindo NÃO pode derrubar
 * o fluxo de reunião do atendente. Por isso nenhum método lança — cada um
 * devolve null/[] e loga o motivo, e quem chama decide o fallback (em geral:
 * seguir com quem está marcando).
 */

const log = createLogger('painel');

/** O painel interno pode ser lento sem travar o clique do atendente pra sempre. */
export const PAINEL_TIMEOUT_MS = 15_000;
/**
 * Teto curto pras chamadas que ficam NA FRENTE do clique do atendente.
 * A distribuição roda antes de criar o link: com os 15 s cheios, um painel que
 * aceita a conexão e não responde (firewall dropando, serviço travado) faria o
 * botão parecer travado. Passado esse tempo a gente desiste e atribui a quem
 * marcou — o resultado é pior, mas a reunião sai.
 */
export const PAINEL_TIMEOUT_CLIQUE_MS = 4_000;

/** Tipos de reunião cujo responsável vem da distribuição do painel interno. */
export type TipoDistribuivel = 'migracao' | 'implantacao' | 'cs';

export interface PessoaPainel {
  email: string;
  nome: string;
}

export interface JanelaDisponivel {
  inicio: string;
  fim: string;
}

export interface DadosOnboarding {
  nome?: string;
  instancia?: string;
  telefone?: string;
}

/** O que registramos no painel interno depois de criar uma reunião. */
export interface RegistroReuniaoPainel {
  meetingId: string;
  sessionId: string;
  tipo: string | null;
  /** Quem clicou (e-mail do @chatpro:auth). */
  atendenteEmail: string | null;
  /** Responsável calculado (distribuição/vendedor/atendente). */
  responsavelEmail: string | null;
  meetUrl: string;
  /** ISO do horário marcado; null = reunião pra agora. */
  quando: string | null;
  cliente: { nome: string; cnpj: string; instancia: string; telefone: string } | null;
}

// ─── CNPJ ────────────────────────────────────────────────────────────────────

/** Só os 14 dígitos — é assim que o CNPJ viaja pra API e pro banco. */
export function normalizarCnpj(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * Valida CNPJ de verdade (14 dígitos + os dois dígitos verificadores), não só
 * o formato. Motivo: o CNPJ vai virar CHAVE de consulta no onboarding interno —
 * um dígito trocado devolveria os dados de OUTRA empresa, e o atendente
 * marcaria a reunião com o cliente errado sem perceber.
 */
export function validarCnpj(valor: string): boolean {
  const d = normalizarCnpj(valor);
  if (d.length !== 14) return false;
  // "111...1" passa na conta dos verificadores, mas não é CNPJ de ninguém.
  if (/^(\d)\1{13}$/.test(d)) return false;

  const digito = (tamanho: number): number => {
    const pesos =
      tamanho === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) soma += Number(d[i]) * (pesos[i] ?? 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
}

// ─── Cliente ─────────────────────────────────────────────────────────────────

export interface PainelClientOptions {
  baseUrl: string | undefined;
  apiToken: string | undefined;
  fetchImpl?: typeof fetch;
  /** Injetável nos testes — 15 s de timeout real deixaria a suíte lenta. */
  timeoutMs?: number;
}

export class PainelClient {
  private readonly baseUrl: string | undefined;
  private readonly apiToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PainelClientOptions) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : undefined;
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PAINEL_TIMEOUT_MS;
  }

  estaConfigurado(): boolean {
    return this.baseUrl !== undefined;
  }

  /**
   * Janelas ocupadas/livres entre `inicio` e `fim`.
   *
   * `null` = painel indisponível (fora do ar, sem URL, resposta estranha).
   * Quem chama NÃO deve bloquear o agendamento por causa disso — sem a
   * informação, o agendamento segue e um conflito eventual se resolve depois.
   */
  async disponibilidade(inicio: Date, fim: Date): Promise<JanelaDisponivel[] | null> {
    const dados = await this.tentar(
      'disponibilidade',
      `/disponibilidade?inicio=${encodeURIComponent(inicio.toISOString())}&fim=${encodeURIComponent(fim.toISOString())}`
    );
    if (dados === undefined) return null;
    if (!Array.isArray(dados)) {
      log.warn('disponibilidade: resposta não é uma lista — tratando como indisponível.');
      return null;
    }
    const janelas: JanelaDisponivel[] = [];
    for (const item of dados) {
      const inicioItem = campoTexto(item, 'inicio');
      const fimItem = campoTexto(item, 'fim');
      if (inicioItem && fimItem) janelas.push({ inicio: inicioItem, fim: fimItem });
    }
    return janelas;
  }

  /**
   * Quem fica responsável por uma reunião AGENDADA de migração/implantação/CS —
   * a lógica de distribuição mora no painel interno, não aqui.
   *
   * `null` = sem resposta utilizável; quem chama cai no atendente que marcou.
   */
  async distribuirResponsavel(tipo: TipoDistribuivel): Promise<PessoaPainel | null> {
    // Timeout curto: esta chamada segura o clique do atendente.
    const dados = await this.tentar(
      'distribuicao',
      '/distribuicao',
      { tipo },
      Math.min(this.timeoutMs, PAINEL_TIMEOUT_CLIQUE_MS)
    );
    const pessoa = lerPessoa(dados);
    if (dados !== undefined && !pessoa) {
      log.warn(`distribuição de '${tipo}' respondeu sem email/nome — caindo no atendente.`);
    }
    return pessoa;
  }

  /** Lista de vendedores pro seletor da apresentação agendada. `[]` = sem painel. */
  async vendedores(): Promise<PessoaPainel[]> {
    const dados = await this.tentar('vendedores', '/vendedores');
    if (dados === undefined) return [];
    if (!Array.isArray(dados)) {
      log.warn('vendedores: resposta não é uma lista — devolvendo vazio.');
      return [];
    }
    const lista: PessoaPainel[] = [];
    for (const item of dados) {
      const pessoa = lerPessoa(item);
      if (pessoa) lista.push(pessoa);
    }
    return lista;
  }

  /**
   * Dados do cliente no onboarding interno, consultados por CNPJ (o caminho da
   * MIGRAÇÃO: o cliente já existe lá dentro, ninguém redigita nome/telefone).
   * `null` = não achou OU painel indisponível — nos dois casos o atendente
   * preenche na mão, então a distinção não muda nada pra quem chama.
   */
  async onboardingPorCnpj(cnpj: string): Promise<DadosOnboarding | null> {
    const dados = await this.tentar(
      'onboarding',
      `/onboarding?cnpj=${encodeURIComponent(normalizarCnpj(cnpj))}`
    );
    if (dados === undefined || dados === null || typeof dados !== 'object') return null;
    const nome = campoTexto(dados, 'nome');
    const instancia = campoTexto(dados, 'instancia');
    const telefone = campoTexto(dados, 'telefone');
    if (!nome && !instancia && !telefone) return null;
    return {
      ...(nome ? { nome } : {}),
      ...(instancia ? { instancia } : {}),
      ...(telefone ? { telefone } : {}),
    };
  }

  /**
   * Registra a reunião criada no painel interno — MELHOR ESFORÇO. A reunião já
   * existe no nosso banco quando isto roda; se o painel estiver fora do ar, o
   * registro se perde lá (e fica logado aqui), mas o atendimento não trava.
   */
  async registrarReuniao(dados: RegistroReuniaoPainel): Promise<void> {
    const resposta = await this.tentar('registro de reunião', '/reunioes', {
      ...dados,
      // O CNPJ viaja normalizado — o painel interno não deve depender da máscara.
      cliente: dados.cliente
        ? { ...dados.cliente, cnpj: normalizarCnpj(dados.cliente.cnpj) }
        : null,
    });
    if (resposta !== undefined) {
      log.info(`reunião ${dados.meetingId} registrada no painel interno.`);
    }
  }

  /**
   * Chamada HTTP que NUNCA lança: `undefined` sinaliza "não deu" (sem URL,
   * timeout, HTTP não-2xx, rede). Cada método público traduz isso pro seu
   * fallback. Com corpo vira POST; sem corpo, GET.
   */
  private async tentar(
    operacao: string,
    caminho: string,
    corpo?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown | undefined> {
    if (!this.baseUrl) {
      log.debug(`PAINEL_API_URL vazia — ${operacao} pulada (integração desligada).`);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Só o header leva o token — ele nunca aparece em log nem em erro.
      if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
      const resposta = await this.fetchImpl(`${this.baseUrl}${caminho}`, {
        method: corpo === undefined ? 'GET' : 'POST',
        headers,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
        signal: controller.signal,
      });
      if (!resposta.ok) {
        log.warn(`painel interno: ${operacao} respondeu HTTP ${resposta.status}.`);
        return undefined;
      }
      const texto = await resposta.text().catch(() => '');
      if (!texto) return null;
      try {
        return JSON.parse(texto) as unknown;
      } catch {
        log.warn(`painel interno: ${operacao} respondeu algo que não é JSON.`);
        return undefined;
      }
    } catch (err) {
      log.warn(
        controller.signal.aborted
          ? `painel interno: ${operacao} não respondeu em ${Math.round(this.timeoutMs / 1000)} s (timeout).`
          : `painel interno: ${operacao} falhou — ${errorMessage(err)}`
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Lê `{ email, nome }` de forma defensiva — resposta fora do formato vira null. */
function lerPessoa(dados: unknown): PessoaPainel | null {
  if (dados === null || typeof dados !== 'object') return null;
  const email = campoTexto(dados, 'email');
  if (!email || !email.includes('@')) return null;
  return { email, nome: campoTexto(dados, 'nome') ?? email };
}

function campoTexto(objeto: unknown, chave: string): string | undefined {
  if (objeto === null || typeof objeto !== 'object') return undefined;
  const valor = (objeto as Record<string, unknown>)[chave];
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : undefined;
}
