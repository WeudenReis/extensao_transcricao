import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Carrega e valida as variáveis de ambiente com zod.
 * Falha cedo (throw com mensagem clara em PT-BR) se algo obrigatório faltar.
 */

const envSchema = z.object({
  GOOGLE_CLIENT_ID: z
    .string({ required_error: 'GOOGLE_CLIENT_ID é obrigatório (OAuth Client do GCP).' })
    .min(1, 'GOOGLE_CLIENT_ID é obrigatório (OAuth Client do GCP).'),
  GOOGLE_CLIENT_SECRET: z
    .string({ required_error: 'GOOGLE_CLIENT_SECRET é obrigatório (OAuth Client do GCP).' })
    .min(1, 'GOOGLE_CLIENT_SECRET é obrigatório (OAuth Client do GCP).'),
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
}

export class ConfigError extends Error {}

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
  };
}
