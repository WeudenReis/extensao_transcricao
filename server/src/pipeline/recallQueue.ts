import type { Db, MeetingRow, MeetingStatus, RecallEventRow } from '../db.js';
import { RecallApiError, type RecallClient } from '../recall/client.js';
import type { ChatproClient, ResultadoEntrega } from '../chatpro/client.js';
import { normalizarTranscript, type Fala } from '../recall/transcript.js';
import { gerarResumo, formatarResumo, resumoExtrativo } from '../resumo/index.js';
import { createLogger, errorMessage } from '../log.js';
import { detectarTopicos, formatarComentarioPalavras } from '../palavras/motor.js';
import type { PainelClient } from '../painel/client.js';

/**
 * Fila DURÁVEL dos webhooks do Recall.ai (tabela recall_events).
 *
 * Por que existe: o Recall exige 2xx em até 15 s e desativa endpoints que
 * falham por 5 dias. Processar inline (baixar transcript, entregar ao chatPro)
 * não cabe nesse orçamento. Então o webhook só GRAVA o evento e responde; aqui
 * o trabalho acontece com retry:
 *
 * - falha transitória (5xx/429/timeout) → backoff 30 s → 15 min, máx 8 → dead
 * - 4xx definitivo do Recall → dead na hora (retentar não muda nada)
 * - reunião ainda não gravada (corrida entre POST /api/meetings e o webhook)
 *   → segue pending; só depois de ~10 min vira dead
 *
 * Mesmo desenho da event_queue do Pub/Sub, que já provou valor aqui.
 */

const log = createLogger('pipeline/recallQueue');

export const RECALL_MAX_ATTEMPTS = 8;
export const RECALL_BASE_BACKOFF_MS = 30_000;
export const RECALL_MAX_BACKOFF_MS = 15 * 60_000;
export const RECALL_WORKER_INTERVAL_MS = 15_000;
/** Depois disso, webhook cujo bot não existe aqui é abandonado. */
export const MEETING_AUSENTE_MAX_AGE_MS = 10 * 60_000;
/** Quantos eventos vencidos processamos por passada. */
export const RECALL_LOTE = 10;

export const EVENTO_TRANSCRIPT_DONE = 'transcript.done';

/** Evento do Recall → estado da reunião. O que não está aqui é só informativo. */
export const STATUS_POR_EVENTO: Readonly<Record<string, MeetingStatus>> = {
  'bot.joining_call': 'joining',
  'bot.in_waiting_room': 'waiting_room',
  'bot.in_call_recording': 'recording',
  'bot.call_ended': 'ended',
  'bot.done': 'done',
  'bot.fatal': 'failed',
  'transcript.failed': 'failed',
};

/** Backoff exponencial: 30 s, 60 s, 120 s… teto de 15 min. */
export function computeRecallBackoffMs(tentativasFeitas: number): number {
  const expoente = Math.max(0, tentativasFeitas - 1);
  return Math.min(RECALL_BASE_BACKOFF_MS * 2 ** expoente, RECALL_MAX_BACKOFF_MS);
}

// ─── Leitura defensiva do payload ────────────────────────────────────────────
// O corpo vem de fora e não temos garantia de forma: nada de cast cego.

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

function texto(valor: unknown): string | undefined {
  return typeof valor === 'string' && valor !== '' ? valor : undefined;
}

/** `event` — o que aconteceu (bot.in_call_recording, transcript.done…). */
export function extrairEvento(payload: unknown): string | undefined {
  return texto(objeto(payload)?.event);
}

/** `data.bot.id` — o único elo entre o webhook e a nossa tabela meetings. */
export function extrairBotId(payload: unknown): string | undefined {
  const bot = objeto(objeto(objeto(payload)?.data)?.bot);
  return texto(bot?.id);
}

function metadataDoBot(payload: unknown): Record<string, unknown> | undefined {
  return objeto(objeto(objeto(objeto(payload)?.data)?.bot)?.metadata);
}

/** `data.bot.metadata.session_id` — o vínculo com a conversa do chatPro. */
export function extrairSessionId(payload: unknown): string | undefined {
  return texto(metadataDoBot(payload)?.session_id);
}

/**
 * `data.bot.metadata.meeting_id` — a nossa própria linha em `meetings`.
 * É o plano B quando o bot_id não casa: acontece quando o createBot estourou o
 * timeout mas o Recall criou o bot mesmo assim.
 */
export function extrairMeetingId(payload: unknown): string | undefined {
  return texto(metadataDoBot(payload)?.meeting_id);
}

/** `data.data.sub_code` — o porquê de um bot.fatal / transcript.failed. */
export function extrairSubCode(payload: unknown): string | undefined {
  const dados = objeto(objeto(objeto(payload)?.data)?.data);
  return texto(dados?.sub_code);
}

// ─── Transcript salvo ────────────────────────────────────────────────────────

export interface TranscriptSalvo {
  falas: Fala[];
  participantes: { nome: string; isHost: boolean; email: string | null }[];
}

/**
 * Lê o `transcript_json` da reunião (o que o worker gravou). Devolve null
 * quando ainda não há transcript — nunca lança, pra um JSON estragado não
 * derrubar uma rota.
 */
export function lerTranscriptSalvo(transcriptJson: string | null): TranscriptSalvo | null {
  if (!transcriptJson) return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(transcriptJson);
  } catch {
    log.warn('transcript_json ilegível no banco — tratando como ausente.');
    return null;
  }
  const raiz = objeto(bruto);
  if (!raiz) return null;
  return {
    falas: Array.isArray(raiz.falas) ? (raiz.falas as Fala[]) : [],
    participantes: Array.isArray(raiz.participantes)
      ? (raiz.participantes as TranscriptSalvo['participantes'])
      : [],
  };
}

/** Estados em que a reunião não anda mais — é quando cabe avisar. */
function ehTerminal(status: MeetingStatus): boolean {
  return status === 'ended' || status === 'done' || status === 'failed';
}

/**
 * Tem transcrição de VERDADE? Um transcript salvo mas sem nenhuma fala não
 * conta: significa que o download veio vazio, e isso pode ser só o arquivo
 * ainda não populado do lado do Recall. Tratar vazio como pronto congelaria a
 * reunião nesse estado pra sempre.
 */
export function temTranscript(meeting: MeetingRow): boolean {
  const salvo = lerTranscriptSalvo(meeting.transcript_json);
  return (salvo?.falas.length ?? 0) > 0;
}

/**
 * Entrega a transcrição já salva ao chatPro e carimba o `chatpro_status`.
 * Usada tanto pelo envio automático (AUTO_SEND_CHATPRO) quanto pelo botão
 * do painel — o resultado precisa ser idêntico nos dois caminhos.
 */
export interface OpcoesEntrega {
  /** Chave da Anthropic. Sem ela o resumo não é gerado e vai só o cabeçalho. */
  anthropicApiKey?: string | undefined;
  geminiApiKey?: string | undefined;
  resumoProvedor?: 'auto' | 'anthropic' | 'gemini' | 'extrativo' | undefined;
  resumoModelo?: string | undefined;
  /** Link do painel, pra apontar onde está a transcrição completa. */
  painelUrl?: string | undefined;
  /** Painel de reuniões — destino da transcrição completa. */
  painel?: PainelClient | undefined;
  /** Injetável nos testes. */
  gerarResumoImpl?: typeof gerarResumo;
}

export async function entregarAoChatpro(
  db: Db,
  chatpro: ChatproClient,
  meeting: MeetingRow,
  opcoes: OpcoesEntrega = {}
): Promise<ResultadoEntrega> {
  const salvo = lerTranscriptSalvo(meeting.transcript_json);
  if (!salvo) {
    return {
      ok: false,
      status: 'failed',
      motivo: 'reunião ainda sem transcrição salva',
    };
  }

  // O comentário leva SÓ O RESUMO — decisão do produto. A transcrição completa
  // continua salva e visível no painel, mas não vai pra conversa do cliente.
  //
  // Como o resumo é o único conteúdo, ele NÃO PODE ser um ponto único de
  // falha: `gerarResumo` devolve null em vez de lançar (sem chave, timeout,
  // resposta inválida), e `formatarResumo` produz o cabeçalho com duração,
  // participantes e link mesmo com null. Assim, o pior caso entrega algo útil
  // em vez de nada.
  const gerar = opcoes.gerarResumoImpl ?? gerarResumo;
  const resumo = await gerar({
    falas: salvo.falas,
    participantes: salvo.participantes,
    duracaoSegundos: meeting.duration_seconds ?? 0,
    apiKey: opcoes.anthropicApiKey,
    geminiApiKey: opcoes.geminiApiKey,
    provedor: opcoes.resumoProvedor,
    modelo: opcoes.resumoModelo,
  });
  // Piso: se a IA não produziu nada (sem chave, fora do ar, resposta ruim), o
  // extrativo entra no lugar. O comentário leva SÓ o resumo — deixar vazio
  // significaria o cliente não receber nada.
  const comPiso = resumo ?? resumoExtrativo(salvo.falas);
  const conteudo = formatarResumo(comPiso, {
    duracaoSegundos: meeting.duration_seconds ?? 0,
    participantes: salvo.participantes,
    meetingUrl: meeting.meeting_url,
    painelUrl: opcoes.painelUrl,
  });
  log.info(
    `reunião ${meeting.id}: comentário montado ` +
      `(resumo ${resumo ? 'por IA' : comPiso ? 'extrativo' : 'indisponível — só cabeçalho'}, ${conteudo.length} chars).`
  );

  // Palavras-chave: lógica de programação pura, sem IA. Roda mesmo quando o
  // resumo por IA falhou — é dicionário e expressão regular, não depende de
  // rede nem de chave. O que o CLIENTE falou é o que pesa, então o motor conta
  // as menções dele separado das do atendente.
  //
  // Vai junto do resumo, num comentário só: duas entregas dobrariam o risco de
  // republicar em caso de retomada, e a fatia de partes já é resolvida ali.
  let corpo = conteudo;
  try {
    const topicos = detectarTopicos(salvo.falas);
    const bloco = formatarComentarioPalavras(topicos, { tipo: meeting.tipo ?? undefined });
    if (bloco) {
      corpo = `${conteudo}\n\n${bloco}`;
      db.setMeetingPalavras(
        meeting.id,
        topicos.map((t) => t.chave)
      );
      log.info(`reunião ${meeting.id}: ${topicos.length} tópico(s) detectado(s) sem IA.`);
    }
  } catch (err) {
    // Detecção é enfeite: se ela quebrar, o resumo ainda tem que chegar.
    log.warn(`reunião ${meeting.id}: falha ao detectar palavras-chave: ${errorMessage(err)}`);
  }

  const resultado = await chatpro.enviar({
    conteudo: corpo,
    sessionId: meeting.session_id,
    meetingUrl: meeting.meeting_url,
    meetingCode: meeting.meeting_code,
    startedAt: meeting.started_at,
    endedAt: meeting.ended_at,
    durationSeconds: meeting.duration_seconds ?? 0,
    participants: salvo.participantes,
    transcript: salvo.falas,
    source: 'recall-ai',
    instanceId: meeting.chatpro_instance_id,
    // Retomada: se uma tentativa anterior entregou parte das mensagens, esta
    // continua de onde parou em vez de repetir o que já está na conversa.
    partesEnviadas: meeting.chatpro_parts_sent ?? 0,
    // Grava parte a parte. Se o processo cair no meio da entrega, o que já
    // entrou fica registrado e a retomada não republica.
    aoEntregarParte: (n) => {
      db.setMeetingChatproStatus(meeting.id, 'pending', n);
    },
  });
  db.setMeetingChatproStatus(meeting.id, resultado.status, resultado.partesEnviadas);

  // A transcrição COMPLETA mora no painel de reuniões — a conversa do cliente
  // só recebe resumo e palavras-chave. Entrega em melhor esforço e DEPOIS do
  // comentário: o painel fora do ar não pode segurar o que o atendente vê.
  await entregarAoPainel(db, meeting, salvo, opcoes);

  return resultado;
}

/**
 * Sobe a transcrição pro painel (POST /meetings/{id}/transcript).
 *
 * Só acontece quando a reunião nasceu lá (tem `painel_meeting_id`): reunião
 * criada pelo plano B do Google Calendar não tem destino no painel.
 *
 * Nunca lança e nunca repete uma entrega que já deu certo — o `painel_status`
 * é o que impede a transcrição de subir duas vezes quando o Recall reentrega
 * o mesmo `transcript.done`.
 */
async function entregarAoPainel(
  db: Db,
  meeting: MeetingRow,
  salvo: TranscriptSalvo,
  opcoes: OpcoesEntrega
): Promise<void> {
  const painel = opcoes.painel;
  const idNoPainel = meeting.painel_meeting_id;
  if (!painel || !idNoPainel) return;
  if (meeting.painel_status === 'enviado') return;
  if (salvo.falas.length === 0) return;

  // O painel quer texto corrido com quem falou, não o nosso JSON.
  const texto = salvo.falas
    .map((f) => `${f.speaker ?? 'Participante'}: ${f.text ?? ''}`.trim())
    .filter((l) => l.length > 1)
    .join('\n\n');
  if (texto === '') return;

  const ok = await painel.enviarTranscricao({
    meetingId: idNoPainel,
    // O painel exige um usuário ATIVO em actor_email; quem responde pela
    // reunião é o certo, e é quem já está registrado na atribuição.
    actorEmail: meeting.atendente_email ?? '',
    texto,
  });
  db.setPainelStatus(meeting.id, ok ? 'enviado' : 'falhou');
}

/**
 * Trava por reunião: duas entregas simultâneas (o worker automático e o botão
 * do painel, por exemplo) leriam `chatpro_parts_sent` antes de qualquer uma
 * gravar e postariam a transcrição em dobro na conversa do cliente.
 */
const entregasEmCurso = new Map<string, Promise<ResultadoEntrega>>();

export function entregarAoChatproComTrava(
  db: Db,
  chatpro: ChatproClient,
  meeting: MeetingRow,
  opcoes: OpcoesEntrega = {}
): Promise<ResultadoEntrega> {
  const emCurso = entregasEmCurso.get(meeting.id);
  if (emCurso) {
    log.info(`entrega da reunião ${meeting.id} já está em curso — aguardando a que já roda.`);
    return emCurso;
  }
  // Relê a linha na hora de entregar: quem esperou a trava precisa do
  // chatpro_parts_sent atualizado pela entrega anterior.
  const promessa = (async (): Promise<ResultadoEntrega> => {
    const atual = db.getMeeting(meeting.id) ?? meeting;
    return entregarAoChatpro(db, chatpro, atual, opcoes);
  })().finally(() => {
    entregasEmCurso.delete(meeting.id);
  });
  entregasEmCurso.set(meeting.id, promessa);
  return promessa;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

export interface RecallQueueWorkerOptions {
  db: Db;
  /** undefined quando RECALL_API_KEY não está configurada (modo dev). */
  recall: RecallClient | undefined;
  chatpro: ChatproClient;
  /** AUTO_SEND_CHATPRO — false deixa a entrega para o botão do painel. */
  autoSendChatpro: boolean;
  /** Passa adiante pro resumo por IA e pro link do painel no comentário. */
  entrega?: OpcoesEntrega;
  /** Injetável nos testes para controlar o relógio. */
  now?: () => Date;
}

/** O que o webhook entrega pra fila (corpo cru preservado como veio). */
export interface WebhookEnfileiravel {
  event: string;
  botId: string | null;
  payloadJson: string;
  /** Header `webhook-id` do Svix — é ele que deduplica a reentrega. */
  webhookId: string | null;
}

export class RecallQueueWorker {
  private readonly db: Db;
  private readonly recall: RecallClient | undefined;
  private readonly chatpro: ChatproClient;
  private readonly autoSendChatpro: boolean;
  private readonly opcoesEntrega: OpcoesEntrega;
  private readonly nowFn: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(options: RecallQueueWorkerOptions) {
    this.db = options.db;
    this.recall = options.recall;
    this.chatpro = options.chatpro;
    this.autoSendChatpro = options.autoSendChatpro;
    this.opcoesEntrega = options.entrega ?? {};
    this.nowFn = options.now ?? ((): Date => new Date());
  }

  private now(): Date {
    return this.nowFn();
  }

  /**
   * Chamado pelo webhook DEPOIS de conferir a assinatura: grava na fila.
   * Lança em erro de banco — aí o endpoint responde 5xx e o Recall reentrega.
   */
  enqueueFromWebhook(entrada: WebhookEnfileiravel): {
    id: number;
    created: boolean;
  } {
    const agoraIso = this.now().toISOString();
    const resultado = this.db.enqueueRecallEvent({
      webhookId: entrada.webhookId,
      event: entrada.event,
      botId: entrada.botId,
      payloadJson: entrada.payloadJson,
      nextAttemptAt: agoraIso,
      createdAt: agoraIso,
    });
    const bot = entrada.botId ?? '(sem bot)';
    log.info(
      resultado.created
        ? `webhook ${entrada.event} enfileirado (#${resultado.id}), bot ${bot}`
        : `webhook ${entrada.event} já estava na fila (#${resultado.id}) — reentrega ignorada`
    );
    return resultado;
  }

  /** Dispara uma passada fora do intervalo (ex.: logo após responder o webhook). */
  poke(): void {
    setImmediate(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('passada avulsa do worker do Recall falhou', err);
      });
    });
  }

  /** Retoma o que ficou pendente de antes do restart. */
  resumePending(): void {
    const { pending } = this.db.countRecallEvents();
    if (pending === 0) return;
    log.info(`${pending} webhook(s) do Recall pendente(s) — retomando após o boot.`);
    this.poke();
  }

  async processOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const vencidos = this.db.dueRecallEvents(this.now().toISOString(), RECALL_LOTE);
      for (const row of vencidos) {
        await this.processRow(row);
      }
    } finally {
      this.processing = false;
    }
  }

  private async processRow(row: RecallEventRow): Promise<void> {
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // Não deveria acontecer (o endpoint só enfileira JSON válido).
        this.db.markRecallEventDead(row.id, 'payload_json ilegível');
        log.error(`evento #${row.id} morto: payload_json ilegível.`);
        return;
      }

      const botId = row.bot_id ?? extrairBotId(payload) ?? null;
      const meeting = this.acharReuniao(botId, payload);

      // O vínculo com o chatPro pode chegar depois da criação do bot.
      if (meeting) this.preencherSessionId(meeting, payload);

      const status = STATUS_POR_EVENTO[row.event];
      const acionavel = row.event === EVENTO_TRANSCRIPT_DONE || status !== undefined;
      if (!acionavel) {
        // transcript.processing, recording.done, bot.in_call_not_recording…:
        // informativos, não mudam nosso estado. Encerram sem retentar.
        this.db.markRecallEventDone(row.id);
        log.debug(`evento #${row.id} (${row.event}) sem efeito de estado — encerrado.`);
        return;
      }

      if (!botId) {
        this.db.markRecallEventDead(row.id, `webhook ${row.event} sem data.bot.id`);
        log.error(`evento #${row.id} morto: ${row.event} chegou sem data.bot.id.`);
        return;
      }

      if (!meeting) {
        this.semReuniao(row, botId);
        return;
      }

      if (row.event === EVENTO_TRANSCRIPT_DONE) {
        await this.processarTranscriptDone(row, meeting, botId);
        return;
      }

      // Aqui `status` é sempre definido: `acionavel` já garantiu isso.
      if (status) await this.aplicarStatus(row, meeting, status, payload);
    } catch (err) {
      if (err instanceof RecallApiError && !ehTransitorio(err)) {
        this.db.markRecallEventDead(row.id, `Recall recusou de forma definitiva: ${err.message}`);
        log.error(`evento #${row.id} (${row.event}) morto — HTTP ${err.status} do Recall.`);
        return;
      }
      this.fail(row, errorMessage(err));
    }
  }

  /** bot.* / transcript.failed → só mexe no estado da reunião. */
  private async aplicarStatus(
    row: RecallEventRow,
    meeting: MeetingRow,
    status: MeetingStatus,
    payload: unknown
  ): Promise<void> {
    // Webhook pode chegar FORA DE ORDEM: o Svix reentrega por 24 h, então um
    // bot.call_ended atrasado (ou um transcript.failed de uma tentativa
    // anterior) pode aparecer DEPOIS que a transcrição já foi salva e entregue.
    // Sem esta guarda, a reunião pronta voltaria pra 'ended' — ou pior, pra
    // 'failed', e o painel diria ao operador que não há transcrição, com a
    // transcrição intacta no banco.
    if (temTranscript(meeting) && status !== 'done') {
      this.db.markRecallEventDone(row.id);
      log.info(
        `evento #${row.id} (${row.event}) chegou atrasado — reunião ${meeting.id} já está ` +
          `concluída com transcrição, status preservado.`
      );
      return;
    }

    let motivo: string | null = null;
    if (status === 'failed') {
      const subCode = extrairSubCode(payload);
      motivo = subCode ? `${row.event}: ${subCode}` : row.event;
    }
    this.db.updateMeetingStatus(meeting.id, status, motivo);
    this.db.markRecallEventDone(row.id);
    log.info(`reunião ${meeting.id} → ${status}${motivo ? ` (${motivo})` : ` (${row.event})`}`);

    // A reunião acabou sem nunca ter gravado? Avisa na conversa.
    if (ehTerminal(status)) await this.avisarSeNaoGravou(meeting.id);
  }

  /**
   * Reunião que terminou sem gravação vira um aviso na conversa do chatPro.
   *
   * É o buraco que motivou o projeto inteiro. O bot entra como convidado
   * anônimo e alguém precisa ADMITIR ele; se ninguém admite, a conversa
   * acontece e não fica registro — e hoje isso falhava em silêncio, que é o
   * pior jeito de falhar, porque parece que está tudo certo.
   *
   * Só avisa uma vez: o carimbo em `chatpro_status` é o que segura a repetição
   * quando um webhook atrasado reentra por aqui.
   */
  private async avisarSeNaoGravou(meetingId: string): Promise<void> {
    const m = this.db.getMeeting(meetingId);
    if (!m) return;
    if (temTranscript(m)) return; // gravou: nada a avisar
    if (m.chatpro_status === 'sent' || m.chatpro_status === 'aviso-enviado') return;
    if (!m.session_id) return; // sem conversa, não há onde avisar

    // `recording` no meio do caminho significa que chegou a gravar; aí a
    // ausência de transcrição é outro problema (transcript.failed), com outra
    // mensagem. Aqui tratamos só o caso de nunca ter entrado.
    const nuncaGravou = m.started_at === null;
    const texto = nuncaGravou
      ? '⚠️ Esta reunião *não foi gravada* — o bot ficou na sala de espera e ninguém o admitiu.\n' +
        'Na próxima, admita o participante "chatPro (gravando)" quando ele pedir para entrar.'
      : '⚠️ A reunião foi gravada, mas a *transcrição não ficou pronta*.\n' +
        'Se precisar dela, fale com quem cuida da ferramenta.';

    try {
      const r = await this.chatpro.comentar({
        sessionId: m.session_id,
        message: texto,
        instanceId: m.chatpro_instance_id,
      });
      if (r.ok) {
        this.db.setMeetingChatproStatus(m.id, 'aviso-enviado');
        log.warn(`reunião ${m.id} terminou sem gravação — avisado na conversa ${m.session_id}.`);
      }
    } catch (err) {
      // Aviso é efeito colateral: falhar aqui não pode derrubar o processamento
      // do evento, que já foi concluído acima.
      log.warn(`não deu pra avisar que a reunião ${m.id} não gravou: ${errorMessage(err)}`);
    }
  }

  /** transcript.done → baixa, normaliza, grava e (se configurado) entrega. */
  private async processarTranscriptDone(
    row: RecallEventRow,
    meeting: MeetingRow,
    botId: string
  ): Promise<void> {
    // Idempotência. O mesmo transcript.done pode voltar a ser processado: se o
    // servidor cair entre a entrega e o markDone, a linha continua 'pending' e
    // é retomada no boot; e o Recall pode reemitir o evento com outro
    // webhook-id (aí o UNIQUE do webhook_id não deduplica). Sem esta guarda,
    // baixaríamos de novo e a transcrição chegaria DUPLICADA na conversa do
    // chatPro — exatamente o tipo de duplicidade que já apareceu neste projeto.
    // Repare que a guarda exige transcrição NÃO VAZIA: um `{falas:[]}` salvo
    // numa tentativa anterior não pode bloquear a tentativa boa.
    if (temTranscript(meeting)) {
      log.info(
        `reunião ${meeting.id} já tem transcrição salva — evento #${row.id} não rebaixa nada.`
      );
      if (meeting.chatpro_status !== 'sent') await this.entregar(meeting.id);
      this.db.markRecallEventDone(row.id);
      return;
    }

    if (!this.recall) {
      this.db.markRecallEventDead(
        row.id,
        'RECALL_API_KEY não configurada — sem ela não dá pra baixar o transcript.'
      );
      log.error(`evento #${row.id} morto: transcript.done sem RECALL_API_KEY configurada.`);
      return;
    }

    const url = await this.recall.getTranscriptDownloadUrl(botId);
    if (!url) {
      // Acontece: o webhook chega um instante antes do link ficar disponível.
      this.fail(row, 'transcript.done recebido, mas o download_url ainda não apareceu');
      return;
    }

    const bruto = await this.recall.downloadTranscript(url);
    const normalizado = normalizarTranscript(bruto);

    // Download vazio: quase sempre é o arquivo ainda sendo escrito do lado do
    // Recall — o webhook chega antes de o conteúdo estar lá. Salvar isso como
    // sucesso entregaria uma transcrição em branco ao chatPro e marcaria a
    // reunião como pronta, sem volta. Então retenta com backoff; só depois de
    // esgotar as tentativas aceitamos que a reunião foi mesmo vazia (o bot pode
    // ter ficado preso na sala de espera e não ter gravado nada).
    if (normalizado.falas.length === 0 && row.attempts + 1 < RECALL_MAX_ATTEMPTS) {
      this.fail(row, 'transcript baixado veio vazio — pode não estar pronto ainda');
      return;
    }
    if (normalizado.falas.length === 0) {
      log.warn(
        `reunião ${meeting.id}: transcript continuou vazio depois de ` +
          `${RECALL_MAX_ATTEMPTS} tentativas — ninguém falou, ou o bot não foi admitido.`
      );
    }

    this.db.setMeetingTranscript({
      id: meeting.id,
      transcriptJson: JSON.stringify({
        falas: normalizado.falas,
        participantes: normalizado.participantes,
      }),
      durationSeconds: normalizado.duracaoSegundos,
    });
    this.db.updateMeetingStatus(meeting.id, 'done');
    log.info(
      `reunião ${meeting.id}: transcrição salva ` +
        `(${normalizado.falas.length} falas, ${normalizado.duracaoSegundos}s).`
    );

    await this.entregar(meeting.id);
    this.db.markRecallEventDone(row.id);
  }

  /** Entrega ao chatPro — ou deixa 'pending' pro botão do painel. */
  private async entregar(meetingId: string): Promise<void> {
    if (!this.autoSendChatpro) {
      this.db.setMeetingChatproStatus(meetingId, 'pending');
      log.info(
        `AUTO_SEND_CHATPRO desligado — reunião ${meetingId} aguarda envio manual pelo painel.`
      );
      return;
    }
    // Relê a linha: precisa do transcript e dos horários recém-gravados.
    const atual = this.db.getMeeting(meetingId);
    if (!atual) return;
    const resultado = await entregarAoChatproComTrava(
      this.db,
      this.chatpro,
      atual,
      this.opcoesEntrega
    );
    if (!resultado.ok && resultado.status === 'failed') {
      log.warn(
        `entrega automática ao chatPro falhou (reunião ${meetingId}) — reenvie pelo painel.`
      );
    }
  }

  /**
   * Acha a reunião do webhook. Primeiro pelo bot_id; se não achar, pelo
   * `metadata.meeting_id` que nós mesmos mandamos ao criar o bot — e aí amarra
   * o bot_id, que é o caso do createBot que estourou o timeout com o bot já
   * criado do lado do Recall.
   */
  private acharReuniao(botId: string | null, payload: unknown): MeetingRow | undefined {
    if (botId) {
      const porBot = this.db.getMeetingByBotId(botId);
      if (porBot) return porBot;
    }
    const meetingId = extrairMeetingId(payload);
    if (!meetingId) return undefined;
    const porMetadata = this.db.getMeeting(meetingId);
    if (!porMetadata) return undefined;

    if (botId && porMetadata.bot_id !== botId) {
      this.db.setMeetingBotId(meetingId, botId);
      log.info(
        `reunião ${meetingId} reencontrada pelo metadata e amarrada ao bot ${botId} ` +
          `(a resposta do createBot tinha se perdido).`
      );
      return this.db.getMeeting(meetingId) ?? porMetadata;
    }
    return porMetadata;
  }

  /** Preenche session_id quando o webhook trouxe o vínculo e a reunião não tem. */
  private preencherSessionId(meeting: MeetingRow, payload: unknown): void {
    if (meeting.session_id) return;
    const sessionId = extrairSessionId(payload);
    if (!sessionId) return;
    this.db.setMeetingSessionId(meeting.id, sessionId);
    log.info(
      `reunião ${meeting.id} vinculada à sessão ${sessionId} (veio no metadata do webhook).`
    );
  }

  /**
   * Webhook cujo bot ainda não tem reunião gravada. NÃO é para morrer: o
   * POST /api/meetings pode ter demorado a commitar. Depois de ~10 min, aí sim
   * desistimos (bot criado fora deste servidor, ou banco recriado).
   */
  private semReuniao(row: RecallEventRow, botId: string): void {
    const idadeMs = this.now().getTime() - Date.parse(row.created_at);
    if (idadeMs > MEETING_AUSENTE_MAX_AGE_MS) {
      const motivo =
        `nenhuma reunião com bot_id ${botId} apareceu em ` +
        `${Math.round(MEETING_AUSENTE_MAX_AGE_MS / 60_000)} min — bot criado fora deste servidor?`;
      this.db.markRecallEventDead(row.id, motivo);
      log.error(`evento #${row.id} (${row.event}) morto: ${motivo}`);
      return;
    }
    this.fail(row, `reunião do bot ${botId} ainda não gravada — aguardando`);
  }

  /** Falha transitória: continua pending, com backoff; no limite vira dead. */
  private fail(row: RecallEventRow, motivo: string): void {
    const tentativas = row.attempts + 1;
    if (tentativas >= RECALL_MAX_ATTEMPTS) {
      this.db.markRecallEventDead(row.id, motivo, tentativas);
      log.error(`evento #${row.id} (${row.event}) morto após ${tentativas} tentativas: ${motivo}`);
      return;
    }
    const proxima = new Date(
      this.now().getTime() + computeRecallBackoffMs(tentativas)
    ).toISOString();
    this.db.recordRecallEventFailure(row.id, tentativas, proxima, motivo);
    log.warn(
      `evento #${row.id} (${row.event}) falhou ` +
        `(tentativa ${tentativas}/${RECALL_MAX_ATTEMPTS}) — próxima em ${proxima}: ${motivo}`
    );
  }

  startWorker(intervalMs: number = RECALL_WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('worker da fila do Recall falhou', err);
      });
    }, intervalMs);
    this.timer.unref();
    log.info(`worker da fila do Recall iniciado (a cada ${Math.round(intervalMs / 1000)} s).`);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  queueDepth(): { pending: number; done: number; dead: number } {
    return this.db.countRecallEvents();
  }
}

/**
 * Vale retentar? Indisponibilidade (5xx), throttling (429), timeout e falha de
 * rede (status 0) passam; 4xx é decisão do Recall e não muda com o tempo.
 */
function ehTransitorio(err: unknown): boolean {
  if (err instanceof RecallApiError) {
    return err.timedOut || err.status === 0 || err.status === 429 || err.status >= 500;
  }
  return true;
}
