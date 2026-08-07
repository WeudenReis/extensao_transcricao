import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import type { RecallClient } from '../recall/client.js';
import { criarReuniao } from '../recall/criarReuniao.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Webhook do chatPro Chat: **POST /webhooks/chatpro/{segredo}**
 *
 * É o que torna a gravação automática. O atendente manda o link do Meet na
 * conversa; o chatPro dispara `sent_message` pra cá; nós lemos o link e o
 * `session_id` do mesmo payload e mandamos o bot. Nenhum botão, nada rodando
 * na máquina de ninguém — que era o ponto de trocar as extensões pelo Recall.
 *
 * SEGREDO NO CAMINHO, e não header: o chatPro não assina os webhooks dele
 * (diferente do Recall, que usa Svix). Sem nenhuma prova de origem, este
 * endpoint deixaria qualquer um disparar bots na nossa conta — e bot custa por
 * hora. O segredo na URL é o que o chatPro consegue guardar, então é o que dá
 * pra usar. Sem `CHATPRO_WEBHOOK_SECRET` configurado a rota nem existe.
 *
 * Responde 200 na hora e cria o bot DEPOIS: criar leva segundos (chamada ao
 * Recall) e não dá pra segurar o webhook do chatPro esperando.
 */

const log = createLogger('routes/chatproHook');

/**
 * Link de reunião do Meet no meio de um texto qualquer.
 * O código tem o formato `xxx-yyyy-zzz`; exigir esse desenho evita casar com
 * `meet.google.com/` sozinho ou com links de outras telas do produto.
 */
export const MEET_NO_TEXTO = /https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;

/** Eventos de mensagem — os únicos que podem carregar um link. */
const EVENTOS_DE_MENSAGEM = new Set(['sent_message', 'received_message']);

/**
 * Teto de bots criados por este webhook numa janela. Existe porque o gatilho é
 * TEXTO DE MENSAGEM: num produto de atendimento por WhatsApp, quem escreve a
 * mensagem pode ser qualquer estranho que tenha o número da instância. O
 * segredo na URL prova que o chatPro é quem chamou, não que o conteúdo é
 * confiável. Sem teto, uma rajada de links diferentes viraria uma rajada de
 * bots cobrados por hora.
 */
export const TETO_BOTS_JANELA = 10;
export const JANELA_TETO_MS = 10 * 60_000;

export interface DadosMensagem {
  event: string;
  message: string;
  sessionId: string | null;
  instanceId: string | null;
  fromMe: boolean;
}

function objeto(valor: unknown): Record<string, unknown> | undefined {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : undefined;
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** Lê o payload do chatPro sem confiar na forma — nada de cast cego. */
export function lerEvento(payload: unknown): DadosMensagem | null {
  const raiz = objeto(payload);
  const event = texto(raiz?.event);
  if (!event) return null;

  const dados = objeto(raiz?.message_data);
  return {
    event,
    message: texto(dados?.message) ?? '',
    sessionId: texto(dados?.session_id),
    instanceId: texto(dados?.instance_id),
    fromMe: dados?.from_me === true,
  };
}

/** Extrai a URL do Meet da mensagem. Devolve null quando não há link. */
export function acharLinkDoMeet(mensagem: string): string | null {
  const m = MEET_NO_TEXTO.exec(mensagem);
  if (!m) return null;
  // Normaliza pra forma canônica: sem query, sem barra final, minúsculo.
  return `https://meet.google.com/${(m[1] ?? '').toLowerCase()}`;
}

/** Compara o segredo em tempo constante. */
function segredoConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ChatproHookDeps {
  db: Db;
  recall: RecallClient | undefined;
  botName: string;
  /** CHATPRO_WEBHOOK_SECRET. Vazio = a rota não é registrada. */
  secret: string | undefined;
  /** CHATPRO_AUTO_START_BOT — false só observa e loga, sem criar bot. */
  autoStart: boolean;
  /**
   * Aceitar link mandado PELO CLIENTE (`received_message`)? Padrão false: o
   * fluxo real é o atendente mandar o link, e aceitar do cliente entrega o
   * gatilho de um recurso cobrado a qualquer estranho que escreva na conversa.
   */
  aceitarDoCliente?: boolean;
  /** Injetável nos testes. */
  agora?: () => number;
  /** Injetável nos testes: por padrão dispara em segundo plano. */
  agendar?: (tarefa: () => Promise<void>) => void;
}

export function createChatproHookRouter(deps: ChatproHookDeps): Router {
  const { db, recall, botName, secret, autoStart } = deps;
  const aceitarDoCliente = deps.aceitarDoCliente === true;
  const agora = deps.agora ?? ((): number => Date.now());
  const router = Router();

  /** Horários das criações recentes — o teto olha só a janela corrente. */
  const criacoesRecentes: number[] = [];
  const dentroDoTeto = (): boolean => {
    const limite = agora() - JANELA_TETO_MS;
    while (criacoesRecentes.length > 0 && (criacoesRecentes[0] ?? 0) < limite) {
      criacoesRecentes.shift();
    }
    return criacoesRecentes.length < TETO_BOTS_JANELA;
  };

  if (!secret) {
    // Sem segredo não há como distinguir o chatPro de um estranho. Melhor a
    // rota não existir do que existir aberta.
    return router;
  }

  const agendar =
    deps.agendar ??
    ((tarefa: () => Promise<void>): void => {
      setImmediate(() => {
        tarefa().catch((err: unknown) => {
          log.error('criação de bot disparada pelo chatPro falhou', err);
        });
      });
    });

  router.post('/webhooks/chatpro/:segredo', (req, res) => {
    if (!segredoConfere(req.params.segredo ?? '', secret)) {
      // 404 de propósito: não confirma que o endpoint existe pra quem tentar
      // adivinhar o caminho.
      log.warn('webhook do chatPro com segredo inválido — recusado.');
      res.status(404).json({ error: 'Não encontrado.' });
      return;
    }

    const evento = lerEvento(req.body);
    if (!evento) {
      res.status(200).json({ ok: true, ignorado: 'payload sem event' });
      return;
    }
    if (!EVENTOS_DE_MENSAGEM.has(evento.event)) {
      // opened_session, closed_session e afins: não interessam por enquanto,
      // mas responder 200 evita o chatPro reentregar pra sempre.
      res.status(200).json({ ok: true, ignorado: evento.event });
      return;
    }

    const meetingUrl = acharLinkDoMeet(evento.message);
    if (!meetingUrl) {
      res.status(200).json({ ok: true, ignorado: 'mensagem sem link do Meet' });
      return;
    }

    // Link mandado pelo CLIENTE só vale se explicitamente liberado. O fluxo
    // real é o atendente mandar; aceitar do cliente entregaria o gatilho de um
    // recurso cobrado a qualquer um que escreva no WhatsApp da empresa.
    if (!evento.fromMe && !aceitarDoCliente) {
      log.info(
        `link do Meet veio do cliente na sessão ${evento.sessionId ?? '?'} — ignorado ` +
          '(CHATPRO_ACEITAR_LINK_DO_CLIENTE não está ligado).'
      );
      res.status(200).json({ ok: true, ignorado: 'link do cliente' });
      return;
    }
    if (!evento.sessionId) {
      log.warn(`link do Meet visto sem session_id no payload (${evento.event}) — ignorado.`);
      res.status(200).json({ ok: true, ignorado: 'sem session_id' });
      return;
    }
    if (!autoStart) {
      log.info(
        `link do Meet visto na sessão ${evento.sessionId}, mas CHATPRO_AUTO_START_BOT=false — ` +
          'nenhum bot enviado.'
      );
      res.status(200).json({ ok: true, ignorado: 'auto-start desligado' });
      return;
    }

    if (!dentroDoTeto()) {
      // Nunca 4xx: o chatPro reentregaria. Recusamos o gasto e registramos alto
      // — é sinal de rajada, e é melhor o operador ver isso na conta do log do
      // que na fatura do Recall.
      log.error(
        `TETO ATINGIDO: ${TETO_BOTS_JANELA} bots em ${Math.round(JANELA_TETO_MS / 60_000)} min. ` +
          `Link de ${meetingUrl} ignorado. Se foi legítimo, dispare pelo painel.`
      );
      res.status(200).json({ ok: true, ignorado: 'teto de criação atingido' });
      return;
    }
    criacoesRecentes.push(agora());

    // 200 primeiro: criar o bot fala com o Recall e leva segundos.
    res.status(200).json({ ok: true, meetingUrl, sessionId: evento.sessionId });

    const sessionId = evento.sessionId;
    const instanceId = evento.instanceId;
    agendar(async () => {
      const r = await criarReuniao(
        { db, recall, botName },
        { meetingUrl, sessionId, chatproInstanceId: instanceId, origem: 'chatpro-webhook' }
      );
      if (r.ok) {
        log.info(
          r.criada
            ? `bot enviado pra ${meetingUrl} (sessão ${sessionId}) — link visto na conversa.`
            : `${meetingUrl} já tinha bot; nada novo criado.`
        );
        return;
      }
      // Não relançamos: o operador vê a reunião como 'failed' no painel e pode
      // reenviar de lá. Perder o webhook em silêncio é que não pode.
      log.error(`falha ao mandar o bot pra ${meetingUrl}: ${errorMessage(r.erro)}`);
    });
  });

  return router;
}
