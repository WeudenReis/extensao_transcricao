import { createLogger, errorMessage } from '../log.js';
import { CHATPRO_BASE_PADRAO } from './client.js';

/**
 * Etiquetas automáticas no chatPro depois que a reunião termina.
 *
 * A etiqueta ("tag"/"label") mora no LEAD, não na sessão. Então são dois
 * passos: descobrir o lead da conversa e só então marcar.
 *
 *   POST {base}/sessions/getSessionById  { instanceId, sessionId } → { lead_id }
 *   POST {base}/tags/assignLabel         (corpo abaixo)
 *   header em ambas: instance-token
 *
 * PRÉ-REQUISITO MANUAL (uma vez por conta): as três etiquetas precisam ser
 * criadas no chatPro — pela tela ou por `POST /tags/create` — e o id de cada
 * uma colocado no .env:
 *
 *   CHATPRO_TAG_REALIZADA      → reunião aconteceu e a transcrição foi entregue
 *   CHATPRO_TAG_SEM_GRAVACAO   → o bot entrou mas não voltou gravação/transcrição
 *   CHATPRO_TAG_LONGA          → passou do tempo esperado (vale revisão humana)
 *
 * Sem o id, a etiqueta correspondente é simplesmente pulada: quem quiser usar
 * só uma das três não precisa criar as outras.
 *
 * ISTO É EFEITO COLATERAL. Etiqueta é conveniência; a transcrição no comentário
 * é o produto. Por isso nada aqui lança: o retorno diz o que entrou e o que
 * falhou, e o chamador segue a vida.
 */

const log = createLogger('chatpro-etiquetas');

const TIMEOUT_MS = 15_000;

export type SituacaoReuniao = 'realizada' | 'sem-gravacao' | 'longa';

/** Todas as situações conhecidas — útil pra validar entrada vinda de fora. */
export const SITUACOES_REUNIAO = ['realizada', 'sem-gravacao', 'longa'] as const;

export interface EtiquetadorOptions {
  baseUrl: string;
  instanceToken: string | undefined;
  instanceId: string | undefined;
  /** Id da etiqueta por situação. Situação ausente aqui é pulada. */
  ids: Partial<Record<SituacaoReuniao, string>>;
  fetchImpl?: typeof fetch;
}

export interface ResultadoEtiquetas {
  /** Situações que viraram etiqueta de fato no lead. */
  aplicadas: SituacaoReuniao[];
  /** Motivos legíveis das que não entraram. Vazio quando deu tudo certo. */
  erros: string[];
}

export class Etiquetador {
  private readonly baseUrl: string;
  private readonly instanceToken: string | undefined;
  private readonly instanceId: string | undefined;
  private readonly ids: Partial<Record<SituacaoReuniao, string>>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EtiquetadorOptions) {
    this.baseUrl = (options.baseUrl || CHATPRO_BASE_PADRAO).replace(/\/+$/, '');
    this.instanceToken = options.instanceToken;
    this.instanceId = options.instanceId;
    this.ids = options.ids;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Só faz sentido tentar se dá pra autenticar E há ao menos uma etiqueta
   * configurada — sem nenhum id, o recurso inteiro está desligado.
   */
  estaConfigurado(): boolean {
    const temAlgumId = Object.values(this.ids).some((id) => typeof id === 'string' && id !== '');
    return Boolean(this.instanceToken && this.instanceId && temAlgumId);
  }

  /**
   * Lead dono da conversa, lido de `/sessions/getSessionById` (campo `lead_id`,
   * confirmado na resposta real).
   *
   * Devolve `null` em vez de lançar: sem lead não há o que etiquetar, e isso
   * não pode virar exceção no meio da entrega da transcrição.
   */
  async leadDaSessao(sessionId: string, instanceId?: string): Promise<string | null> {
    const alvo = instanceId ?? this.instanceId;
    if (!alvo) {
      log.warn(`sem instanceId pra consultar a sessão ${sessionId}.`);
      return null;
    }
    try {
      const sessao = await this.postar('/sessions/getSessionById', { instanceId: alvo, sessionId });
      const raiz = (sessao ?? {}) as Record<string, unknown>;
      // A API já respondeu ora achatada, ora dentro de `session`/`data`.
      const dados = (raiz.session ?? raiz.data ?? raiz) as Record<string, unknown>;
      const bruto = dados?.lead_id ?? dados?.leadId;
      // Já veio numérico em algumas contas; normalizamos pra string.
      if (typeof bruto === 'number' && Number.isFinite(bruto)) return String(bruto);
      if (typeof bruto === 'string' && bruto !== '') return bruto;
      log.warn(`sessão ${sessionId} não trouxe lead_id — nada a etiquetar.`);
      return null;
    } catch (err) {
      log.warn(`não deu pra ler o lead da sessão ${sessionId}: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Marca o lead da sessão com as etiquetas das situações pedidas.
   *
   * Cada etiqueta é uma chamada independente: uma que falhe não cancela as
   * outras, e o que falhou volta descrito em `erros`.
   */
  async aplicar(
    sessionId: string,
    situacoes: SituacaoReuniao[],
    instanceId?: string
  ): Promise<ResultadoEtiquetas> {
    const resultado: ResultadoEtiquetas = { aplicadas: [], erros: [] };

    if (!this.estaConfigurado()) {
      log.info('etiquetas não configuradas — nada a marcar (recurso opcional).');
      return resultado;
    }

    // A mesma situação pedida duas vezes não vira duas chamadas.
    const pendentes: { situacao: SituacaoReuniao; tagId: string }[] = [];
    const vistas = new Set<SituacaoReuniao>();
    for (const situacao of situacoes) {
      if (vistas.has(situacao)) continue;
      vistas.add(situacao);
      const tagId = this.ids[situacao];
      if (!tagId) {
        // Silêncio proposital: pular etiqueta não configurada é o comportamento
        // esperado de quem só quis usar uma das três.
        log.info(`etiqueta '${situacao}' sem id no .env — pulada.`);
        continue;
      }
      pendentes.push({ situacao, tagId });
    }
    if (pendentes.length === 0) return resultado;

    const alvo = instanceId ?? this.instanceId;
    const leadId = await this.leadDaSessao(sessionId, alvo);
    if (!leadId) {
      resultado.erros.push(`sessão ${sessionId} sem lead — nenhuma etiqueta aplicada`);
      return resultado;
    }

    for (const { situacao, tagId } of pendentes) {
      try {
        /**
         * ATENÇÃO: este corpo NÃO foi verificado contra a API real. Ele segue a
         * convenção dos outros endpoints sparks (camelCase, sempre com
         * instanceId), mas é o palpite deste arquivo. Se `/tags/assignLabel`
         * responder HTTP 400, o ajuste é AQUI — o candidato mais provável é o
         * nome do campo da etiqueta (`tagId` vs. `labelId`).
         */
        await this.postar('/tags/assignLabel', {
          instanceId: alvo,
          leadId,
          tagId,
        });
        resultado.aplicadas.push(situacao);
      } catch (err) {
        const motivo = errorMessage(err);
        resultado.erros.push(`etiqueta '${situacao}': ${motivo}`);
        log.warn(`falha ao aplicar a etiqueta '${situacao}' no lead ${leadId}: ${motivo}`);
      }
    }

    log.info(
      `etiquetas na sessão ${sessionId}: ${resultado.aplicadas.length} aplicada(s), ` +
        `${resultado.erros.length} falha(s).`
    );
    return resultado;
  }

  /** POST autenticado no chatPro Chat. Lança com o motivo em caso de erro. */
  private async postar(caminho: string, corpo: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resposta = await this.fetchImpl(`${this.baseUrl}${caminho}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'instance-token': this.instanceToken ?? '',
        },
        body: JSON.stringify(corpo),
        signal: controller.signal,
      });
      const texto = await resposta.text().catch(() => '');
      if (!resposta.ok) {
        // Só status e o começo do corpo do chatPro — nunca o nosso token.
        throw new Error(
          `chatPro respondeu HTTP ${resposta.status}${texto ? ` — ${texto.slice(0, 200)}` : ''}`
        );
      }
      if (!texto) return null;
      try {
        return JSON.parse(texto) as unknown;
      } catch {
        // Endpoint que responde vazio ou texto puro: o sucesso é o status.
        return null;
      }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`chatPro não respondeu em ${Math.round(TIMEOUT_MS / 1000)} s (timeout).`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
