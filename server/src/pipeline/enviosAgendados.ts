import type { Db } from '../db.js';
import type { ChatproClient } from '../chatpro/client.js';
import { createLogger, errorMessage } from '../log.js';
import { formatarQuando } from '../routes/reunioes.js';

/**
 * Worker dos ENVIOS AGENDADOS (tabela envios_agendados).
 *
 * Reunião marcada pra depois não manda o convite na hora de marcar: a mensagem
 * com o link sai ~5 min antes do horário, quando o cliente vai realmente usar.
 * A rota grava a mensagem pronta na fila durável; este worker varre a fila a
 * cada 30 s e dispara o que venceu via chatPro.
 *
 * Três decisões que moram aqui:
 *
 * 1. **Sem retry.** Convite é sensível a tempo: diferente da transcrição (que
 *    vale entregar horas depois), um convite que chega DEPOIS da reunião é pior
 *    que nenhum — o atendente vê 'falhou' no painel e manda na mão. Falhou,
 *    marca 'falhou' com o motivo e pronto.
 * 2. **Janela perdida.** Se o servidor ficou fora do ar e o envio venceu há
 *    mais de 30 min, nem tenta: marca 'falhou' com "janela perdida". Mandar
 *    "sua reunião é daqui a 5 min" com a reunião já acabada só confunde.
 * 3. **Reunião morta leva os convites junto.** Se a reunião foi cancelada
 *    ('failed') ou nem existe mais (expurgo), o convite pendente é cancelado —
 *    o cliente não pode receber link de reunião que não vai acontecer.
 */

const log = createLogger('pipeline/enviosAgendados');

export const ENVIOS_WORKER_INTERVAL_MS = 30_000;

/**
 * Atraso máximo tolerado depois do `enviar_em`. Como o convite sai 5 min antes
 * da reunião, 30 min de atraso significa que a reunião já começou há ~25 min —
 * convite nenhum salva esse caso.
 */
export const JANELA_PERDIDA_MS = 30 * 60_000;

/** Lote por passada — o mesmo teto das outras filas deste projeto. */
const LOTE_POR_PASSADA = 10;

/** O que uma passada fez — vira log e dá aos testes algo observável. */
export interface ResumoPassada {
  enviados: number;
  falhados: number;
  cancelados: number;
  /** Vencidos há mais de 30 min, marcados 'falhou' sem tentar. */
  perdidos: number;
}

export interface EnviosAgendadosWorkerOptions {
  db: Db;
  chatpro: ChatproClient;
  /** Injetável nos testes para controlar o relógio. */
  now?: () => Date;
}

export class EnviosAgendadosWorker {
  private readonly db: Db;
  private readonly chatpro: ChatproClient;
  private readonly nowFn: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(options: EnviosAgendadosWorkerOptions) {
    this.db = options.db;
    this.chatpro = options.chatpro;
    this.nowFn = options.now ?? (() => new Date());
  }

  /** Uma passada: pega os envios vencidos e resolve cada um. */
  async processOnce(): Promise<ResumoPassada> {
    const resumo: ResumoPassada = { enviados: 0, falhados: 0, cancelados: 0, perdidos: 0 };
    // Passadas não se sobrepõem: o envio do chatPro é assíncrono e uma passada
    // lenta deixaria a próxima pegar o MESMO envio ainda 'pendente' — o
    // cliente receberia o convite duas vezes.
    if (this.processing) return resumo;
    this.processing = true;
    try {
      const agora = this.nowFn();
      const vencidos = this.db.enviosVencidos(agora.toISOString(), LOTE_POR_PASSADA);
      for (const envio of vencidos) {
        // NÃO cancelamos por causa do estado da reunião aqui, e isso é
        // deliberado: `failed` quer dizer que o BOT falhou (Recall fora do ar,
        // sem API key), não que a reunião foi desmarcada. O link do Meet já
        // existe na agenda e o atendente já foi avisado de que a reunião está
        // marcada — segurar o convite deixaria os dois lados esperando um pelo
        // outro. Reunião sem registro no banco é o mesmo caso: quando o Recall
        // não está configurado, o envio nasce com um id órfão de propósito.
        //
        // Cancelamento de verdade é ato explícito e chama
        // `cancelarEnviosDaReuniao` na hora — não se descobre por status.
        const reuniao = this.db.getMeeting(envio.meeting_id);

        const atrasoMs = agora.getTime() - Date.parse(envio.enviar_em);
        if (atrasoMs > JANELA_PERDIDA_MS) {
          this.db.marcarEnvio(
            envio.id,
            'falhou',
            `janela perdida — devia ter saído em ${envio.enviar_em}`
          );
          resumo.perdidos += 1;
          log.warn(
            `envio #${envio.id} (reunião ${envio.meeting_id}) vencido há ` +
              `${Math.round(atrasoMs / 60_000)} min — marcado como perdido, sem tentar.`
          );
          continue;
        }

        // O "hoje/amanhã" é resolvido AGORA, não quando a reunião foi marcada.
        // A mensagem ficou dias na fila; texto relativo congelado sairia errado.
        const mensagem = envio.message.includes('{quando}')
          ? envio.message.replace(
              '{quando}',
              envio.reuniao_em ? formatarQuando(new Date(envio.reuniao_em), agora) : 'em instantes'
            )
          : envio.message;

        try {
          const r = await this.chatpro.enviarMensagem({
            sessionId: envio.session_id,
            message: mensagem,
            instanceId: envio.instance_id,
          });
          if (r.ok) {
            this.db.marcarEnvio(envio.id, 'enviado');
            resumo.enviados += 1;
            log.info(`convite #${envio.id} enviado (sessão ${envio.session_id}).`);
          } else {
            this.db.marcarEnvio(envio.id, 'falhou', r.motivo);
            resumo.falhados += 1;
            log.warn(`convite #${envio.id} falhou (sessão ${envio.session_id}): ${r.motivo}`);
          }
        } catch (err) {
          // enviarMensagem não lança por contrato, mas um convite não pode
          // derrubar a passada dos outros se isso um dia mudar.
          this.db.marcarEnvio(envio.id, 'falhou', errorMessage(err));
          resumo.falhados += 1;
          log.error(`convite #${envio.id} estourou`, err);
        }
      }
    } finally {
      this.processing = false;
    }
    return resumo;
  }

  startWorker(intervalMs: number = ENVIOS_WORKER_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processOnce().catch((err: unknown) => {
        log.error('worker de envios agendados falhou', err);
      });
    }, intervalMs);
    this.timer.unref();
    log.info(`worker de envios agendados iniciado (a cada ${Math.round(intervalMs / 1000)} s).`);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
