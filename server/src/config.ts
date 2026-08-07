import dotenv from 'dotenv';
import { z } from 'zod';
import { RECALL_REGIONS, type RecallRegion } from './recall/types.js';

/**
 * Carrega e valida as variáveis de ambiente com zod.
 * Falha cedo (throw com mensagem clara em PT-BR) se algo obrigatório faltar.
 */

const envSchema = z.object({
  // Opcionais: só o caminho Meet REST API v2 (conta Workspace) precisa deles.
  // O caminho de captura de áudio (conta pessoal) funciona sem GCP nenhum.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z
    .string()
    .url('GOOGLE_REDIRECT_URI deve ser uma URL (ex.: http://localhost:3333/oauth/callback).')
    .default('http://localhost:3333/oauth/callback'),
  GOOGLE_PUBSUB_TOPIC: z
    .string()
    .regex(
      /^projects\/[^/]+\/topics\/[^/]+$/,
      'GOOGLE_PUBSUB_TOPIC deve ter o formato projects/{projeto}/topics/{topico}.'
    )
    .optional(),
  PUBSUB_VERIFICATION_AUDIENCE: z.string().optional(),
  PUBSUB_SERVICE_ACCOUNT: z
    .string()
    .email('PUBSUB_SERVICE_ACCOUNT deve ser o e-mail do service account da push subscription.')
    .optional(),
  ALLOW_INSECURE_PUBSUB: z.string().optional(),
  VOREO_WEBHOOK_URL: z.string().url('VOREO_WEBHOOK_URL deve ser uma URL válida.').optional(),
  VOREO_API_KEY: z.string().optional(),
  PORT: z.coerce
    .number()
    .int('PORT deve ser um inteiro.')
    .positive('PORT deve ser positivo.')
    .default(3333),
  DATABASE_PATH: z.string().min(1).default('./data/app.db'),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  // ─── Captura de áudio + STT (transcrição em conta pessoal) ───
  // 'local' = Whisper offline gratuito (padrão). Os demais são opcionais/pagos.
  STT_PROVIDER: z
    .enum(['local', 'deepgram', 'assemblyai', 'whisper', 'none'])
    .default('local'),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().optional(),
  STT_LANGUAGE: z.string().default('pt-BR'),
  STT_BASE_URL: z.string().url('STT_BASE_URL deve ser uma URL.').optional(),
  CAPTURE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  // Enviar automaticamente pra Voreo ao terminar a transcrição?
  // Padrão FALSE: o atendente/admin revisa primeiro e envia pelo botão.
  AUTO_SEND_VOREO: z.string().optional(),
  // ─── Recall.ai (bot que entra na reunião, grava e transcreve) ───
  // Todas opcionais: sem elas o servidor sobe normalmente e o caminho Recall
  // fica desligado (ver recallConfigWarnings abaixo).
  RECALL_API_KEY: z.string().optional(),
  RECALL_REGION: z.enum(RECALL_REGIONS).default('us-west-2'),
  RECALL_WEBHOOK_SECRET: z.string().optional(),
  RECALL_BOT_NAME: z.string().min(1).default('chatPro (gravando)'),
  ALLOW_INSECURE_RECALL: z.string().optional(),
  PUBLIC_BASE_URL: z
    .string()
    .url('PUBLIC_BASE_URL deve ser uma URL https pública (ex.: https://seu-tunel.ngrok.app).')
    .optional(),
  // ─── chatPro (entrega final da transcrição) ───
  CHATPRO_API_URL: z.string().url('CHATPRO_API_URL deve ser uma URL válida.').optional(),
  CHATPRO_API_KEY: z.string().optional(),
  AUTO_SEND_CHATPRO: z.string().optional(),
  // Tranca do painel e das rotas de leitura. Vazio = tudo aberto (dev em
  // localhost). Vira obrigatório na prática assim que o servidor é exposto.
  PANEL_TOKEN: z
    .string()
    .min(16, 'PANEL_TOKEN deve ter ao menos 16 caracteres pra não ser adivinhável.')
    .optional(),
});

export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googlePubsubTopic: string | undefined;
  pubsubVerificationAudience: string | undefined;
  pubsubServiceAccount: string | undefined;
  allowInsecurePubsub: boolean;
  voreoWebhookUrl: string | undefined;
  voreoApiKey: string | undefined;
  port: number;
  databasePath: string;
  tokenEncryptionKey: string | undefined;
  sttProvider: 'local' | 'deepgram' | 'assemblyai' | 'whisper' | 'none';
  sttApiKey: string | undefined;
  sttModel: string | undefined;
  sttLanguage: string;
  sttBaseUrl: string | undefined;
  captureRetentionDays: number;
  autoSendVoreo: boolean;
  recallApiKey: string | undefined;
  recallRegion: RecallRegion;
  recallWebhookSecret: string | undefined;
  recallBotName: string;
  allowInsecureRecall: boolean;
  publicBaseUrl: string | undefined;
  chatproApiUrl: string | undefined;
  chatproApiKey: string | undefined;
  autoSendChatpro: boolean;
  panelToken: string | undefined;
}

export class ConfigError extends Error {}

/**
 * O que falta pro caminho Recall.ai funcionar de ponta a ponta.
 * Nada aqui impede o servidor de subir — é só aviso de boot (modo dev).
 * NUNCA inclui valor de chave/segredo, só o nome da variável.
 */
export function recallConfigWarnings(config: Config): string[] {
  const avisos: string[] = [];
  if (!config.recallApiKey) {
    avisos.push('RECALL_API_KEY vazia — não é possível criar bots no Recall.ai.');
  }
  if (!config.recallWebhookSecret) {
    avisos.push(
      config.allowInsecureRecall
        ? 'RECALL_WEBHOOK_SECRET vazio e ALLOW_INSECURE_RECALL=true — webhooks aceitos SEM assinatura (só dev).'
        : 'RECALL_WEBHOOK_SECRET vazio — /webhooks/recall vai responder 403 (crie o segredo no dashboard).'
    );
  }
  if (!config.publicBaseUrl) {
    avisos.push('PUBLIC_BASE_URL vazia — sem HTTPS público o Recall.ai não entrega webhook.');
  }
  if (!config.chatproApiUrl) {
    avisos.push('CHATPRO_API_URL vazia — entrega ao chatPro fica como skipped-no-url.');
  }
  if (!config.panelToken) {
    // Grave quando somado ao túnel: o Recall só precisa de /webhooks/recall,
    // mas o túnel publica o app inteiro, painel e transcrições junto.
    avisos.push(
      config.publicBaseUrl
        ? 'PANEL_TOKEN vazio COM servidor exposto em PUBLIC_BASE_URL — qualquer um que ' +
          'descobrir a URL lê as transcrições e cria bots cobrados. Configure já.'
        : 'PANEL_TOKEN vazio — painel e API abertos a quem alcançar esta porta. ' +
          'Obrigatório antes de expor o servidor por túnel.'
    );
  }
  return avisos;
}

/** Remove strings vazias — `VAR=` no .env deve contar como "não definida". */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value.trim();
  }
  return cleaned;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  dotenv.config();
  const parsed = envSchema.safeParse(cleanEnv(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(raiz)';
      return `  - ${key}: ${issue.message}`;
    });
    throw new ConfigError(
      `Configuração inválida — corrija o arquivo .env (use .env.example como base):\n${lines.join('\n')}`
    );
  }
  const e = parsed.data;
  return {
    googleClientId: e.GOOGLE_CLIENT_ID,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: e.GOOGLE_REDIRECT_URI,
    googlePubsubTopic: e.GOOGLE_PUBSUB_TOPIC,
    pubsubVerificationAudience: e.PUBSUB_VERIFICATION_AUDIENCE,
    pubsubServiceAccount: e.PUBSUB_SERVICE_ACCOUNT,
    allowInsecurePubsub: e.ALLOW_INSECURE_PUBSUB === 'true',
    voreoWebhookUrl: e.VOREO_WEBHOOK_URL,
    voreoApiKey: e.VOREO_API_KEY,
    port: e.PORT,
    databasePath: e.DATABASE_PATH,
    tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY,
    sttProvider: e.STT_PROVIDER,
    sttApiKey: e.STT_API_KEY,
    sttModel: e.STT_MODEL,
    sttLanguage: e.STT_LANGUAGE,
    sttBaseUrl: e.STT_BASE_URL,
    captureRetentionDays: e.CAPTURE_RETENTION_DAYS,
    autoSendVoreo: e.AUTO_SEND_VOREO === 'true',
    recallApiKey: e.RECALL_API_KEY,
    recallRegion: e.RECALL_REGION,
    recallWebhookSecret: e.RECALL_WEBHOOK_SECRET,
    recallBotName: e.RECALL_BOT_NAME,
    allowInsecureRecall: e.ALLOW_INSECURE_RECALL === 'true',
    publicBaseUrl: e.PUBLIC_BASE_URL,
    chatproApiUrl: e.CHATPRO_API_URL,
    chatproApiKey: e.CHATPRO_API_KEY,
    autoSendChatpro: e.AUTO_SEND_CHATPRO === 'true',
    panelToken: e.PANEL_TOKEN,
  };
}
