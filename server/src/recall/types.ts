/**
 * Tipos da API do Recall.ai (bot que entra na reunião, grava e transcreve).
 *
 * Fonte: verificação contra a API real em 06/08/2026 (ver ARQUITETURA-RECALL.md).
 * Os campos são declarados como opcionais quando a API pode omiti-los — o
 * contrato é externo e não temos garantia de forma; quem consome checa.
 *
 * REGRA: nada aqui vira log. Transcript é dado sensível de cliente (LGPD) e o
 * `download_url` é um link assinado que dá acesso a ele.
 */

// ─── Região / base URL ───────────────────────────────────────────────────────

export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;

export type RecallRegion = (typeof RECALL_REGIONS)[number];

/** Base da API por região, sem barra no fim: https://us-west-2.recall.ai/api/v1 */
export function recallBaseUrl(region: RecallRegion): string {
  return `https://${region}.recall.ai/api/v1`;
}

// ─── Bot ─────────────────────────────────────────────────────────────────────

/** Metadados que viajam com o bot e voltam em TODO webhook (o vínculo chatPro). */
export interface RecallMetadata {
  session_id?: string;
  [key: string]: string | undefined;
}

export interface RecallTranscriptShortcut {
  id?: string;
  status?: { code?: string; sub_code?: string | null; updated_at?: string };
  /** `data.download_url` é temporário e assinado — nunca logar nem persistir. */
  data?: { download_url?: string | null } | null;
}

export interface RecallMediaShortcuts {
  transcript?: RecallTranscriptShortcut | null;
  video_mixed?: { id?: string; data?: { download_url?: string | null } | null } | null;
  audio_mixed?: { id?: string; data?: { download_url?: string | null } | null } | null;
}

export interface RecallRecording {
  id?: string;
  started_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  media_shortcuts?: RecallMediaShortcuts | null;
}

export interface RecallBotStatusChange {
  code?: string;
  sub_code?: string | null;
  message?: string | null;
  created_at?: string;
}

/** Resposta de POST /bot e GET /bot/{id}. */
export interface RecallBot {
  id: string;
  bot_name?: string;
  meeting_url?: { meeting_id?: string; platform?: string } | string | null;
  join_at?: string | null;
  metadata?: RecallMetadata | null;
  status_changes?: RecallBotStatusChange[];
  recordings?: RecallRecording[];
}

// ─── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Payload comum dos webhooks (Svix). O `event` diz o que aconteceu
 * (`bot.in_call_recording`, `transcript.done`…) e `data.data.code` traz o
 * estado detalhado. `data.bot.metadata.session_id` é o que liga ao chatPro.
 */
export interface RecallWebhookPayload {
  event: string;
  data?: {
    data?: {
      code?: string;
      sub_code?: string | null;
      updated_at?: string;
    };
    bot?: {
      id?: string;
      metadata?: RecallMetadata | null;
    };
    transcript?: { id?: string; metadata?: RecallMetadata | null } | null;
    recording?: { id?: string; metadata?: RecallMetadata | null } | null;
  };
}

// ─── Transcript baixado ──────────────────────────────────────────────────────

export interface RecallWordTimestamp {
  absolute?: string | null;
  /** Segundos desde o início da gravação. */
  relative?: number | null;
}

export interface RecallWord {
  text: string;
  start_timestamp?: RecallWordTimestamp | null;
  end_timestamp?: RecallWordTimestamp | null;
}

export interface RecallParticipant {
  id?: number | string | null;
  name?: string | null;
  is_host?: boolean | null;
  platform?: string | null;
  extra_data?: unknown;
  email?: string | null;
}

/**
 * Um bloco de fala do JSON baixado — a lista inteira é `RecallTranscript[]`.
 * Já vem separado POR PARTICIPANTE: é isso que resolve a diarização que a
 * legenda do Meet nunca deu.
 */
export interface RecallTranscript {
  participant?: RecallParticipant | null;
  language_code?: string | null;
  words?: RecallWord[] | null;
}
