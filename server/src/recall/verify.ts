import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../log.js';

/**
 * Verificação da assinatura dos webhooks do Recall.ai (padrão Svix).
 *
 * O Recall assina cada webhook com HMAC-SHA256 sobre `{id}.{timestamp}.{corpo}`.
 * Sem essa checagem, QUALQUER pessoa que descobrisse a URL poderia injetar
 * transcrições falsas no sistema — por isso a verificação é obrigatória fora
 * do modo de desenvolvimento.
 *
 * Headers enviados:
 *   webhook-id         identificador da mensagem
 *   webhook-timestamp  unix time (segundos)
 *   webhook-signature  "v1,<base64>" (pode ter várias, separadas por espaço)
 *
 * O segredo vem do dashboard e começa com "whsec_".
 * IMPORTANTE: precisa do CORPO CRU (bytes), não do JSON já parseado — por isso
 * a rota usa express.raw().
 */

const log = createLogger('recall/verify');

/** Janela aceita entre o timestamp assinado e agora (proteção contra replay). */
const TOLERANCIA_SEGUNDOS = 5 * 60;

export type ResultadoVerificacao =
  | { ok: true }
  | { ok: false; motivo: string };

/** Remove o prefixo "whsec_" e decodifica o segredo. */
function decodificarSegredo(secret: string): Buffer {
  const semPrefixo = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(semPrefixo, 'base64');
}

/** Compara em tempo constante (evita vazar informação pelo tempo de resposta). */
function iguaisEmTempoConstante(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface EntradaVerificacao {
  secret: string;
  webhookId: string | undefined;
  webhookTimestamp: string | undefined;
  webhookSignature: string | undefined;
  /** Corpo CRU da requisição. */
  body: Buffer | string;
  /** Injetável nos testes. */
  agoraSegundos?: number;
}

export function verificarAssinatura(entrada: EntradaVerificacao): ResultadoVerificacao {
  const { secret, webhookId, webhookTimestamp, webhookSignature } = entrada;

  if (!secret) return { ok: false, motivo: 'segredo de webhook não configurado' };
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, motivo: 'headers de assinatura ausentes' };
  }

  // 1) Timestamp precisa ser recente (anti-replay).
  const ts = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, motivo: 'timestamp inválido' };
  const agora = entrada.agoraSegundos ?? Math.floor(Date.now() / 1000);
  if (Math.abs(agora - ts) > TOLERANCIA_SEGUNDOS) {
    return { ok: false, motivo: 'timestamp fora da janela aceita (replay?)' };
  }

  // 2) Assinatura esperada sobre "{id}.{timestamp}.{corpo}".
  const corpo = Buffer.isBuffer(entrada.body)
    ? entrada.body.toString('utf8')
    : entrada.body;
  const conteudoAssinado = `${webhookId}.${webhookTimestamp}.${corpo}`;
  const esperada = createHmac('sha256', decodificarSegredo(secret))
    .update(conteudoAssinado, 'utf8')
    .digest('base64');

  // 3) O header pode trazer várias assinaturas ("v1,aaa v1,bbb") — basta uma bater.
  const candidatas = webhookSignature
    .split(' ')
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((parte) => (parte.startsWith('v1,') ? parte.slice(3) : parte));

  for (const candidata of candidatas) {
    if (iguaisEmTempoConstante(candidata, esperada)) return { ok: true };
  }
  return { ok: false, motivo: 'assinatura não confere' };
}

/**
 * Política de aceitação do webhook.
 *
 * Sem segredo configurado REJEITAMOS (403) — um endpoint aberto aceitaria
 * transcrição forjada de qualquer um. Só liberamos em desenvolvimento, com
 * ALLOW_INSECURE_RECALL=true e um aviso barulhento no log.
 */
let avisouInseguro = false;

export function podeAceitar(
  entrada: EntradaVerificacao & { permitirInseguro: boolean }
): ResultadoVerificacao {
  if (!entrada.secret) {
    if (entrada.permitirInseguro) {
      if (!avisouInseguro) {
        avisouInseguro = true;
        log.warn(
          'ALLOW_INSECURE_RECALL=true — aceitando webhooks SEM verificar assinatura. ' +
            'Use apenas em desenvolvimento; em produção configure RECALL_WEBHOOK_SECRET.'
        );
      }
      return { ok: true };
    }
    return { ok: false, motivo: 'RECALL_WEBHOOK_SECRET não configurado' };
  }
  return verificarAssinatura(entrada);
}
