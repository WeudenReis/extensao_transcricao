import dotenv from 'dotenv';
import { z } from 'zod';
import { RECALL_REGIONS, type RecallRegion } from './recall/types.js';
import { PROVIDERS, type ChatproProvider } from './chatpro/client.js';
import { PROVEDORES_RESUMO, type ProvedorResumo } from './resumo/index.js';

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
  // Callback do OAuth que a EXTENSÃO usa (conta Google de cada atendente).
  // Precisa estar cadastrado como "Authorized redirect URI" no mesmo OAuth
  // Client do GCP. Diferente do GOOGLE_REDIRECT_URI, que é do fluxo antigo.
  GOOGLE_REDIRECT_URI_EXTENSAO: z
    .string()
    .url('GOOGLE_REDIRECT_URI_EXTENSAO deve ser uma URL.')
    .default('http://localhost:3333/oauth/google/callback'),
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
  // ─── Captura de áudio + STT (caminho ANTIGO, da extensão que gravava) ───
  // Padrão 'none': a transcrição hoje vem pronta do Recall.ai, então ligar isto
  // só faz o servidor baixar ~320 MB de modelo Whisper e carregá-lo no boot sem
  // necessidade. Só mude se for usar de novo a captura de áudio local.
  STT_PROVIDER: z
    .enum(['local', 'deepgram', 'assemblyai', 'whisper', 'none'])
    .default('none'),
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
  // Sobrescreve a base derivada da região. Existe pra teste de ponta a ponta
  // contra um stub — em produção fica vazia e a região manda.
  RECALL_BASE_URL: z.string().url('RECALL_BASE_URL deve ser uma URL válida.').optional(),
  RECALL_BOT_NAME: z.string().min(1).default('chatPro (gravando)'),
  ALLOW_INSECURE_RECALL: z.string().optional(),
  PUBLIC_BASE_URL: z
    .string()
    .url('PUBLIC_BASE_URL deve ser uma URL https pública (ex.: https://seu-tunel.ngrok.app).')
    .optional(),
  // ─── chatPro (entrega final da transcrição) ───
  // Base da API de Chat do chatPro. Só muda em ambiente de teste deles.
  CHATPRO_BASE_URL: z
    .string()
    .url('CHATPRO_BASE_URL deve ser uma URL válida.')
    .default('https://sparks.chatpro.com.br'),
  // Header `instance-token`. Gerado em app.chatpro.com.br → Configurações →
  // Desenvolvedor. Sem ele não dá pra postar a transcrição na conversa.
  CHATPRO_INSTANCE_TOKEN: z.string().optional(),
  // Código da instância, formato `chatpro-xxxxxxxxxx`. Vai no corpo de toda
  // chamada — e também chega sozinho no webhook (message_data.instance_id).
  CHATPRO_INSTANCE_ID: z.string().optional(),
  // Usuário a quem o comentário fica vinculado (a transcrição aparece como
  // dele). Descubra com o endpoint get_all_users_by_instance.
  CHATPRO_USER_ID: z.string().optional(),
  // Canal das conversas. Obrigatório no sendMessage do chatPro.
  CHATPRO_PROVIDER: z.enum(PROVIDERS).default('whatsapp'),
  // Segredo no CAMINHO do webhook: /webhooks/chatpro/{segredo}. O chatPro não
  // assina os webhooks dele, então é isto que impede um terceiro de disparar
  // bots (cobrados por hora) na nossa conta.
  CHATPRO_WEBHOOK_SECRET: z
    .string()
    .min(16, 'CHATPRO_WEBHOOK_SECRET deve ter ao menos 16 caracteres.')
    .optional(),
  // Ao ver um link do Meet numa conversa, já mandar o bot? É o que torna o
  // fluxo automático (sem botão). 'false' deixa só o disparo manual.
  CHATPRO_AUTO_START_BOT: z.string().optional(),
  // 'true' aceita link mandado PELO CLIENTE. Padrão desligado: o gatilho é
  // texto de mensagem, e num WhatsApp de atendimento qualquer estranho escreve.
  CHATPRO_ACEITAR_LINK_DO_CLIENTE: z.string().optional(),
  AUTO_SEND_CHATPRO: z.string().optional(),
  // Ids das etiquetas aplicadas ao lead depois da reunião. Cada etiqueta é
  // criada UMA VEZ no chatPro (tela ou POST /tags/create) e o id vem pra cá.
  // Todas opcionais e independentes: sem o id, aquela etiqueta é só pulada.
  CHATPRO_TAG_REALIZADA: z.string().optional(),
  CHATPRO_TAG_SEM_GRAVACAO: z.string().optional(),
  CHATPRO_TAG_LONGA: z.string().optional(),
  // ─── Resumo da reunião por IA (API da Anthropic) ───
  // Vazia = resumo desligado. Nada quebra: o comentário sai só com o cabeçalho
  // e o aviso de que a transcrição está no painel.
  // Quem escreve o resumo: auto | anthropic | gemini | extrativo.
  // 'auto' usa a chave que existir; sem nenhuma, cai no extrativo (sem IA,
  // custo zero, e a transcrição não sai da máquina).
  RESUMO_PROVEDOR: z.enum(PROVEDORES_RESUMO).default('auto'),
  // Free tier do Google — grátis sem cartão. ATENÇÃO: os termos permitem que o
  // conteúdo do free tier seja usado pra treinar os modelos deles, e o que sai
  // daqui é conversa de cliente. Decida antes de ligar em produção.
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  RESUMO_MODELO: z.string().min(1).default('claude-sonnet-5'),
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
  googleRedirectUriExtensao: string;
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
  recallBaseUrl: string | undefined;
  recallBotName: string;
  allowInsecureRecall: boolean;
  publicBaseUrl: string | undefined;
  chatproBaseUrl: string;
  chatproInstanceToken: string | undefined;
  chatproInstanceId: string | undefined;
  chatproUserId: string | undefined;
  chatproProvider: ChatproProvider;
  chatproWebhookSecret: string | undefined;
  chatproAutoStartBot: boolean;
  chatproAceitarLinkDoCliente: boolean;
  autoSendChatpro: boolean;
  chatproTagRealizada: string | undefined;
  chatproTagSemGravacao: string | undefined;
  chatproTagLonga: string | undefined;
  anthropicApiKey: string | undefined;
  geminiApiKey: string | undefined;
  resumoProvedor: ProvedorResumo;
  resumoModelo: string;
  panelToken: string | undefined;
}

export class ConfigError extends Error {}

/**
 * O que falta pro caminho Recall.ai funcionar de ponta a ponta.
 * Nada aqui impede o servidor de subir — é só aviso de boot (modo dev).
 * NUNCA inclui valor de chave/segredo, só o nome da variável.
 */
/**
 * Quais das três variáveis do chatPro Chat estão faltando. Postar o comentário
 * exige as três juntas — só o token não basta.
 */
export function faltamNoChatpro(config: Config): string[] {
  const faltam: string[] = [];
  if (!config.chatproInstanceToken) faltam.push('CHATPRO_INSTANCE_TOKEN');
  if (!config.chatproInstanceId) faltam.push('CHATPRO_INSTANCE_ID');
  if (!config.chatproUserId) faltam.push('CHATPRO_USER_ID');
  return faltam;
}

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
  const faltam = faltamNoChatpro(config);
  if (faltam.length > 0) {
    avisos.push(
      `chatPro incompleto (${faltam.join(', ')}) — a transcrição fica salva ` +
        'e marcada como skipped-no-url, sem se perder.'
    );
  }
  if (!config.chatproWebhookSecret) {
    avisos.push(
      'CHATPRO_WEBHOOK_SECRET vazio — o disparo automático do bot pelo link do ' +
        'Meet na conversa fica desligado (/webhooks/chatpro responde 404).'
    );
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
    googleRedirectUriExtensao: e.GOOGLE_REDIRECT_URI_EXTENSAO,
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
    recallBaseUrl: e.RECALL_BASE_URL,
    recallBotName: e.RECALL_BOT_NAME,
    allowInsecureRecall: e.ALLOW_INSECURE_RECALL === 'true',
    publicBaseUrl: e.PUBLIC_BASE_URL,
    chatproBaseUrl: e.CHATPRO_BASE_URL,
    chatproInstanceToken: e.CHATPRO_INSTANCE_TOKEN,
    chatproInstanceId: e.CHATPRO_INSTANCE_ID,
    chatproUserId: e.CHATPRO_USER_ID,
    chatproProvider: e.CHATPRO_PROVIDER,
    chatproWebhookSecret: e.CHATPRO_WEBHOOK_SECRET,
    chatproAutoStartBot: e.CHATPRO_AUTO_START_BOT !== 'false',
    chatproAceitarLinkDoCliente: e.CHATPRO_ACEITAR_LINK_DO_CLIENTE === 'true',
    autoSendChatpro: e.AUTO_SEND_CHATPRO === 'true',
    chatproTagRealizada: e.CHATPRO_TAG_REALIZADA,
    chatproTagSemGravacao: e.CHATPRO_TAG_SEM_GRAVACAO,
    chatproTagLonga: e.CHATPRO_TAG_LONGA,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    geminiApiKey: e.GEMINI_API_KEY,
    resumoProvedor: e.RESUMO_PROVEDOR,
    resumoModelo: e.RESUMO_MODELO,
    panelToken: e.PANEL_TOKEN,
  };
}
