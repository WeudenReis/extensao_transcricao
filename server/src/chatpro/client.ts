import { createLogger, errorMessage } from '../log.js';
import type { Fala } from '../recall/transcript.js';

/**
 * Entrega da transcrição ao **chatPro Chat** (produto de conversas — não
 * confundir com a "chatPro API", que é a de instâncias/WhatsApp).
 *
 *   POST {base}/messages/addComments
 *   header: instance-token
 *   corpo:  { instanceId, sessionId, message, userId }
 *
 * A transcrição vira um COMENTÁRIO na sessão do atendimento — fica na conversa
 * certa, visível pro time, sem virar mensagem enviada ao cliente.
 *
 * Duas coisas moldaram este arquivo:
 *
 * 1. `message` é um texto só, e reunião de 40 min não cabe num comentário. Por
 *    isso a transcrição é FATIADA em partes numeradas.
 * 2. Fatiar significa que uma falha no meio deixa a conversa pela metade. Então
 *    o chamador guarda quantas partes já foram (`partesEnviadas`) e o reenvio
 *    continua de onde parou, em vez de repetir o que já está lá — repetição de
 *    transcrição já foi problema real neste projeto.
 */

const log = createLogger('chatpro');

export const MAX_TENTATIVAS = 5;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const TIMEOUT_MS = 20_000;

/**
 * Teto de caracteres por comentário. O chatPro não documenta o limite; 3.500 é
 * folgado o bastante pra passar em qualquer limite de campo de texto comum e
 * pequeno o bastante pra continuar legível na tela do atendimento.
 */
export const MAX_CARACTERES_COMENTARIO = 3_500;

export function backoffMs(tentativasFeitas: number): number {
  const expoente = Math.max(0, tentativasFeitas - 1);
  return Math.min(BASE_BACKOFF_MS * 2 ** expoente, MAX_BACKOFF_MS);
}

export interface ChatproPayload {
  sessionId: string | null;
  meetingUrl: string;
  meetingCode: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  participants: { nome: string; isHost: boolean; email: string | null }[];
  transcript: Fala[];
  source: 'recall-ai';
  /** Instância da conversa. Sem ela, cai na CHATPRO_INSTANCE_ID do .env. */
  instanceId?: string | null;
  /** Quantas partes já foram entregues — o reenvio continua daqui. */
  partesEnviadas?: number;
  /**
   * Chamado DEPOIS de cada parte entrar. É o que faz a retomada funcionar
   * mesmo se o processo morrer no meio: sem isto, o contador só seria gravado
   * no fim e um restart republicaria a transcrição inteira.
   */
  aoEntregarParte?: (partesEnviadas: number) => void;
}

export type ResultadoEntrega =
  | { ok: true; status: 'sent'; partesEnviadas: number }
  | {
      ok: false;
      status: 'skipped-no-url' | 'failed';
      motivo?: string;
      /** Quantas partes entraram antes de falhar (nunca regride). */
      partesEnviadas?: number;
    };

/** Canais que o chatPro aceita em sendMessage. */
export const PROVIDERS = ['whatsapp', 'facebook', 'instagram', 'cloud'] as const;
export type ChatproProvider = (typeof PROVIDERS)[number];

/** Base oficial da API de Chat do chatPro. */
export const CHATPRO_BASE_PADRAO = 'https://sparks.chatpro.com.br';

export interface ChatproClientOptions {
  baseUrl?: string | undefined;
  instanceToken: string | undefined;
  instanceId: string | undefined;
  userId: string | undefined;
  /** Canal padrão das conversas. Praticamente sempre 'whatsapp'. */
  provider?: ChatproProvider;
  fetchImpl?: typeof fetch;
}

// ─── Formatação do comentário ────────────────────────────────────────────────

/** ms → `mm:ss` (ou `h:mm:ss` quando passa da hora). */
export function marcarTempo(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const dois = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dois(m)}:${dois(s)}` : `${dois(m)}:${dois(s)}`;
}

function duracaoLegivel(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto === 0 ? `${h}h` : `${h}h${String(resto).padStart(2, '0')}`;
}

/** Cabeçalho: o que o atendente lê antes de decidir se abre a transcrição. */
export function montarCabecalho(p: ChatproPayload): string {
  const linhas = ['📄 *Transcrição da reunião*'];
  if (p.durationSeconds > 0) {
    linhas[0] += ` — ${duracaoLegivel(p.durationSeconds)}`;
  }
  if (p.participants.length > 0) {
    linhas.push(p.participants.map((x) => x.nome).join(' · '));
  }
  linhas.push(p.meetingUrl);
  return linhas.join('\n');
}

/**
 * Monta as partes do comentário. Nunca corta uma fala no meio: se a fala
 * sozinha já estoura o limite, ela é quebrada em pedaços marcados com `(…)`.
 */
export function montarPartes(
  p: ChatproPayload,
  limite: number = MAX_CARACTERES_COMENTARIO
): string[] {
  const cabecalho = montarCabecalho(p);

  if (p.transcript.length === 0) {
    return [`${cabecalho}\n\n_Ninguém falou durante a gravação._`];
  }

  const linhas = p.transcript.map(
    (f) => `[${marcarTempo(f.startMs)}] *${f.speaker}:* ${f.text}`
  );

  // Espaço útil por parte: o rodapé "(parte n/N)" ainda vai entrar, então
  // reservamos uma folga fixa em vez de recalcular a cada iteração.
  const FOLGA_RODAPE = 24;
  const util = Math.max(200, limite - FOLGA_RODAPE);

  const blocos: string[] = [];
  let atual = '';
  for (const linha of linhas) {
    for (const pedaco of quebrarLinhaLonga(linha, util)) {
      const candidato = atual === '' ? pedaco : `${atual}\n${pedaco}`;
      if (candidato.length > util && atual !== '') {
        blocos.push(atual);
        atual = pedaco;
      } else {
        atual = candidato;
      }
    }
  }
  if (atual !== '') blocos.push(atual);

  // O cabeçalho ocupa espaço na primeira parte: refaz o corte contando com ele.
  const primeiroComCabecalho = `${cabecalho}\n\n${blocos[0] ?? ''}`;
  if (primeiroComCabecalho.length <= util) {
    blocos[0] = primeiroComCabecalho;
  } else {
    blocos.unshift(cabecalho);
  }

  if (blocos.length === 1) return blocos;
  return blocos.map((b, i) => `${b}\n\n_(parte ${i + 1}/${blocos.length})_`);
}

/** Fala gigante que não cabe nem sozinha: quebra em pedaços marcados. */
function quebrarLinhaLonga(linha: string, limite: number): string[] {
  if (linha.length <= limite) return [linha];
  const pedacos: string[] = [];
  let resto = linha;
  while (resto.length > limite) {
    // Corta no último espaço pra não partir palavra ao meio.
    const corte = resto.lastIndexOf(' ', limite - 4);
    const em = corte > limite / 2 ? corte : limite - 4;
    pedacos.push(`${resto.slice(0, em)} (…)`);
    resto = resto.slice(em).trimStart();
  }
  if (resto !== '') pedacos.push(resto);
  return pedacos;
}

// ─── Cliente ─────────────────────────────────────────────────────────────────

export class ChatproClient {
  private readonly baseUrl: string;
  private readonly instanceToken: string | undefined;
  private readonly instanceId: string | undefined;
  private readonly userId: string | undefined;
  private readonly provider: ChatproProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChatproClientOptions) {
    this.baseUrl = (options.baseUrl || CHATPRO_BASE_PADRAO).replace(/\/+$/, '');
    this.instanceToken = options.instanceToken;
    this.instanceId = options.instanceId;
    this.userId = options.userId;
    this.provider = options.provider ?? 'whatsapp';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  estaConfigurado(): boolean {
    return Boolean(this.instanceToken && this.instanceId && this.userId);
  }

  /**
   * Posta a transcrição como comentário(s) na sessão.
   *
   * Retoma de `payload.partesEnviadas`: se a entrega anterior parou na parte 2
   * de 5, esta começa na 3. Sem isso, o reenvio duplicaria o que já está lá.
   */
  async enviar(payload: ChatproPayload): Promise<ResultadoEntrega> {
    const jaEnviadas = Math.max(0, payload.partesEnviadas ?? 0);

    if (!this.estaConfigurado()) {
      log.info(`chatPro não configurado — entrega pulada (modo dev). ${resumir(payload)}`);
      return { ok: false, status: 'skipped-no-url' };
    }
    if (!payload.sessionId) {
      // Sem sessão não há conversa onde comentar. Não é falha transitória:
      // retentar não inventa o vínculo. Fica pro operador ligar no painel.
      log.warn(`reunião sem sessionId do chatPro — nada a comentar. ${resumir(payload)}`);
      return { ok: false, status: 'failed', motivo: 'reunião sem sessão do chatPro vinculada' };
    }

    const instanceId = payload.instanceId ?? this.instanceId;
    if (!instanceId) {
      return { ok: false, status: 'failed', motivo: 'sem instanceId do chatPro' };
    }

    const partes = montarPartes(payload);
    if (jaEnviadas >= partes.length) {
      log.info(`transcrição já estava completa no chatPro (${partes.length} partes).`);
      return { ok: true, status: 'sent', partesEnviadas: partes.length };
    }

    let enviadas = jaEnviadas;
    for (let i = jaEnviadas; i < partes.length; i += 1) {
      const parte = partes[i] ?? '';
      try {
        await this.postarComentario({
          instanceId,
          sessionId: payload.sessionId,
          message: parte,
          userId: this.userId ?? '',
        });
        enviadas = i + 1;
        // Grava JÁ, não no fim: se o processo cair na parte seguinte, a
        // retomada precisa saber que esta aqui já está na conversa.
        payload.aoEntregarParte?.(enviadas);
      } catch (err) {
        const motivo = errorMessage(err);
        log.warn(
          `falha ao postar a parte ${i + 1}/${partes.length} no chatPro: ${motivo} ` +
            `(${enviadas} parte(s) já entregues — o reenvio continua daqui)`
        );
        return { ok: false, status: 'failed', motivo, partesEnviadas: enviadas };
      }
    }

    log.info(`entregue ao chatPro em ${partes.length} parte(s). ${resumir(payload)}`);
    return { ok: true, status: 'sent', partesEnviadas: enviadas };
  }

  /**
   * Manda uma mensagem PRO CLIENTE na conversa (diferente do comentário, que é
   * interno). É o que leva o link do Meet quando o atendente clica no botão.
   *
   * Contrato (confirmado na doc do chatPro Chat):
   *   obrigatórios: sessionId, instanceId, message, provider
   *   opcionais:    quotedMessageId, userId
   *
   * `provider` é o canal da conversa — whatsapp | facebook | instagram | cloud.
   * Sem ele a chamada é recusada.
   */
  async enviarMensagem(entrada: {
    sessionId: string;
    message: string;
    instanceId?: string | null;
    /** Canal da conversa. Cai em CHATPRO_PROVIDER quando não informado. */
    provider?: ChatproProvider | null;
  }): Promise<{ ok: true } | { ok: false; motivo: string }> {
    if (!this.instanceToken) {
      return { ok: false, motivo: 'CHATPRO_INSTANCE_TOKEN não configurado.' };
    }
    const instanceId = entrada.instanceId ?? this.instanceId;
    if (!instanceId) return { ok: false, motivo: 'sem instanceId do chatPro' };

    try {
      await this.postar('/messages/sendMessage', {
        instanceId,
        sessionId: entrada.sessionId,
        message: entrada.message,
        provider: entrada.provider ?? this.provider,
        // Opcional no contrato: só mandamos quando temos.
        ...(this.userId ? { userId: this.userId } : {}),
      });
      log.info(`mensagem enviada ao cliente na sessão ${entrada.sessionId}.`);
      return { ok: true };
    } catch (err) {
      const motivo = errorMessage(err);
      log.warn(`falha ao enviar mensagem na sessão ${entrada.sessionId}: ${motivo}`);
      return { ok: false, motivo };
    }
  }

  private postarComentario(corpo: {
    instanceId: string;
    sessionId: string;
    message: string;
    userId: string;
  }): Promise<void> {
    return this.postar('/messages/addComments', corpo);
  }

  /** POST autenticado no chatPro Chat. Lança com o motivo em caso de erro. */
  private async postar(caminho: string, corpo: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resposta = await this.fetchImpl(`${this.baseUrl}${caminho}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Nome do header exatamente como o chatPro Chat espera.
          'instance-token': this.instanceToken ?? '',
        },
        body: JSON.stringify(corpo),
        signal: controller.signal,
      });
      if (!resposta.ok) {
        // O corpo do erro pode citar o motivo; nunca inclui o nosso token.
        const detalhe = await resposta.text().catch(() => '');
        throw new Error(
          `chatPro respondeu HTTP ${resposta.status}${detalhe ? ` — ${detalhe.slice(0, 200)}` : ''}`
        );
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

/** Resumo seguro pra log — NUNCA o transcript inteiro (dado do cliente). */
function resumir(p: ChatproPayload): string {
  return (
    `sessão ${p.sessionId ?? '(sem vínculo)'}, meet ${p.meetingCode ?? '?'}, ` +
    `${p.transcript.length} falas, ${p.participants.length} participante(s)`
  );
}
