import type { Db, MeetingRow, MeetingStatus } from '../db.js';
import type { RecallClient } from '../recall/client.js';
import type { ChatproClient } from '../chatpro/client.js';
import { normalizarTranscript } from '../recall/transcript.js';
import {
  entregarAoChatproComTrava,
  lerTranscriptSalvo,
  temTranscript,
  type OpcoesEntrega,
} from './recallQueue.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Rede de segurança: PERGUNTA ao Recall o que aconteceu, em vez de esperar o
 * webhook contar.
 *
 * Por que existe: o webhook é o caminho normal, mas ele depende de uma URL
 * pública alcançável. Túnel que caiu, segredo trocado, servidor fora do ar
 * durante a reunião — em qualquer um desses casos o Recall grava e transcreve
 * direitinho, e nós ficamos sem saber. Aconteceu de verdade aqui: seis
 * reuniões paradas em `created` enquanto os bots já tinham chegado a
 * `recording_done`.
 *
 * O Recall reentrega webhook por 24 h, então parte disso se resolveria sozinho
 * — mas só parte, e só se a URL voltar a tempo. Isto fecha o buraco de vez e
 * serve pra recuperar o que já passou.
 *
 * É idempotente: reunião que já tem transcrição não é rebaixada nem reentregue.
 */

const log = createLogger('pipeline/reconciliar');

/** Estado do bot no Recall → estado da reunião aqui. */
const STATUS_POR_CODIGO: Readonly<Record<string, MeetingStatus>> = {
  joining_call: 'joining',
  in_waiting_room: 'waiting_room',
  in_call_not_recording: 'recording',
  in_call_recording: 'recording',
  recording_permission_allowed: 'recording',
  call_ended: 'ended',
  recording_done: 'ended',
  done: 'done',
  fatal: 'failed',
};

export interface ResultadoReconciliacao {
  verificadas: number;
  atualizadas: number;
  transcricoesRecuperadas: number;
  entregues: number;
  erros: string[];
}

export interface ReconciliarDeps {
  db: Db;
  recall: RecallClient | undefined;
  chatpro: ChatproClient;
  entrega?: OpcoesEntrega;
  /**
   * Entregar ao chatPro o que for recuperado. Desligado por padrão: numa
   * recuperação em lote de reuniões antigas, despejar vários comentários de
   * uma vez na conversa do cliente é pior que não entregar.
   */
  entregar?: boolean;
}

/** Reuniões que ainda podem mudar de estado. */
function pendentes(db: Db, limite: number): MeetingRow[] {
  return db
    .listMeetings(200)
    .filter((m) => m.bot_id && (!temTranscript(m) || m.chatpro_status === 'pending'))
    .filter((m) => m.status !== 'failed' || !m.error?.includes('sala reaproveitada'))
    .slice(0, limite);
}

export async function reconciliar(
  deps: ReconciliarDeps,
  limite = 25
): Promise<ResultadoReconciliacao> {
  const r: ResultadoReconciliacao = {
    verificadas: 0,
    atualizadas: 0,
    transcricoesRecuperadas: 0,
    entregues: 0,
    erros: [],
  };
  if (!deps.recall) {
    r.erros.push('RECALL_API_KEY não configurada — não dá pra consultar o Recall.');
    return r;
  }

  for (const meeting of pendentes(deps.db, limite)) {
    r.verificadas += 1;
    try {
      const bot = await deps.recall.getBot(meeting.bot_id as string);

      // O Recall guarda o histórico; o último código é o estado atual.
      const mudancas = (bot as { status_changes?: { code?: string }[] }).status_changes ?? [];
      const ultimo = mudancas.at(-1)?.code;
      const novo = ultimo ? STATUS_POR_CODIGO[ultimo] : undefined;

      if (novo && novo !== meeting.status && !(temTranscript(meeting) && novo !== 'done')) {
        deps.db.updateMeetingStatus(meeting.id, novo);
        r.atualizadas += 1;
        log.info(`reunião ${meeting.id}: ${meeting.status} → ${novo} (pelo Recall, sem webhook).`);
      }

      // Transcrição pronta e ainda não baixada? Puxa agora.
      if (!temTranscript(meeting)) {
        const url = await deps.recall.getTranscriptDownloadUrl(meeting.bot_id as string);
        if (url) {
          const bruto = await deps.recall.downloadTranscript(url);
          const normalizado = normalizarTranscript(bruto);
          if (normalizado.falas.length > 0) {
            deps.db.setMeetingTranscript({
              id: meeting.id,
              transcriptJson: JSON.stringify({
                falas: normalizado.falas,
                participantes: normalizado.participantes,
              }),
              durationSeconds: normalizado.duracaoSegundos,
            });
            deps.db.updateMeetingStatus(meeting.id, 'done');
            r.transcricoesRecuperadas += 1;
            log.info(
              `reunião ${meeting.id}: transcrição RECUPERADA ` +
                `(${normalizado.falas.length} falas, ${normalizado.duracaoSegundos}s).`
            );
          }
        }
      }

      if (deps.entregar) {
        const atual = deps.db.getMeeting(meeting.id);
        if (atual && temTranscript(atual) && atual.chatpro_status !== 'sent') {
          const entrega = await entregarAoChatproComTrava(
            deps.db,
            deps.chatpro,
            atual,
            deps.entrega ?? {}
          );
          if (entrega.ok) r.entregues += 1;
        }
      }
    } catch (err) {
      const motivo = errorMessage(err);
      r.erros.push(`${meeting.id}: ${motivo}`);
      log.warn(`não deu pra reconciliar a reunião ${meeting.id}: ${motivo}`);
    }
  }

  return r;
}

/** Só pra ver o que aconteceu, sem mexer em nada. */
export function resumirReconciliacao(r: ResultadoReconciliacao): string {
  return (
    `${r.verificadas} verificada(s), ${r.atualizadas} com estado atualizado, ` +
    `${r.transcricoesRecuperadas} transcrição(ões) recuperada(s), ${r.entregues} entregue(s)` +
    (r.erros.length ? `, ${r.erros.length} erro(s)` : '')
  );
}
