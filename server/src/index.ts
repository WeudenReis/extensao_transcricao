import express from 'express';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { Db } from './db.js';
import { GoogleAuth, createOAuthRouter } from './google/auth.js';
import { MeetClient } from './google/meet.js';
import { EventsClient, SubscriptionManager } from './google/events.js';
import { TranscriptPipeline } from './pipeline/transcript.js';
import { EventQueueWorker } from './pipeline/eventQueue.js';
import { AudioPipeline } from './pipeline/audioTranscript.js';
import { VoreoClient } from './voreo/client.js';
import { createSttProvider } from './stt/index.js';
import { createApiRouter } from './routes/api.js';
import { createPubSubRouter } from './routes/pubsub.js';
import { createCaptureRouter } from './routes/capture.js';
import { createReviewRouter } from './routes/review.js';
import { startCapturePurgeJob } from './pipeline/purge.js';
import { createLogger, errorMessage } from './log.js';

/**
 * Bootstrap: Express + rotas + tarefas de startup
 * (diretório do DB garantido no construtor do Db; renovação de subscription
 * no boot, após o OAuth conectar e a cada 6 h; worker da fila Voreo a cada 30 s).
 */

const log = createLogger('index');

const SUBSCRIPTION_RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = new Db(config.databasePath);

  const voreo = new VoreoClient({
    db,
    webhookUrl: config.voreoWebhookUrl,
    apiKey: config.voreoApiKey,
  });

  // Declarado antes do auth pra podermos disparar o setup da subscription
  // assim que o OAuth conectar.
  let subscriptions: SubscriptionManager | undefined;

  const auth = new GoogleAuth({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.googleRedirectUri,
    tokenEncryptionKey: config.tokenEncryptionKey,
    db,
    onConnected: () => {
      subscriptions?.renewIfExpiring().catch((err: unknown) => {
        log.error('setup da subscription após OAuth falhou', err);
      });
    },
  });

  const meet = new MeetClient({ getAccessToken: () => auth.getAccessToken() });
  const events = new EventsClient({ getAccessToken: () => auth.getAccessToken() });
  subscriptions = new SubscriptionManager({
    events,
    db,
    pubsubTopic: config.googlePubsubTopic,
    isAuthConnected: () => auth.isConnected(),
  });
  const pipeline = new TranscriptPipeline({ db, meet, voreo });
  const eventQueue = new EventQueueWorker({ db, pipeline });

  // Captura de áudio (caminho que funciona em conta pessoal @gmail).
  const captureDir = join(dirname(resolve(config.databasePath)), 'captures');
  const stt = createSttProvider(config);
  const audioPipeline = new AudioPipeline({
    db,
    captureDir,
    stt,
    language: config.sttLanguage,
    autoSendVoreo: config.autoSendVoreo,
    voreoWebhookUrl: config.voreoWebhookUrl,
    voreoApiKey: config.voreoApiKey,
  });

  const app = express();
  // express.json() só parseia application/json; a rota de chunk usa
  // application/octet-stream com raw() próprio, então o json() global a ignora
  // (não consome o stream) e o raw() da rota lê os bytes normalmente.
  app.use(express.json({ limit: '2mb' }));
  app.use(createCaptureRouter({ db, captureDir, onCaptureStopped: (id) => audioPipeline.enqueue(id) }));
  app.use(createReviewRouter({ db, captureDir, pipeline: audioPipeline }));
  app.use(createOAuthRouter(auth));
  app.use(createApiRouter({ db, meet, auth, voreo, eventQueue }));
  app.use(
    createPubSubRouter({
      eventQueue,
      audience: config.pubsubVerificationAudience,
      serviceAccount: config.pubsubServiceAccount,
      allowInsecure: config.allowInsecurePubsub,
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Rota não encontrada.' });
  });
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      log.error('erro não tratado em rota', err);
      res.status(500).json({ error: 'Erro interno.', detail: errorMessage(err) });
    }
  );

  const googleConfigured = config.googleClientId !== '' && config.googleClientSecret !== '';
  const server = app.listen(config.port, () => {
    log.info(`servidor ouvindo em http://localhost:${config.port}`);
    log.info(`Painel de revisão: http://localhost:${config.port}/`);
    if (googleConfigured) {
      log.info(`OAuth Google: http://localhost:${config.port}/oauth/start`);
      log.info(`Webhook Pub/Sub: POST http://localhost:${config.port}/webhooks/pubsub`);
    } else {
      log.info('Google não configurado — caminho Meet REST API desativado (ok pra conta pessoal).');
    }
    if (!stt) {
      log.warn('STT não configurado — capturas gravam áudio mas não transcrevem. Configure STT_API_KEY.');
    }
  });

  // Tarefas de startup
  voreo.startWorker();
  eventQueue.startWorker();
  eventQueue.poke(); // retoma eventos pendentes que sobraram de antes do restart
  audioPipeline.resumePending(); // retoma capturas 'pending'/'transcribing' interrompidas

  // Pré-carrega o modelo de STT em segundo plano (não bloqueia o boot).
  if (stt?.warmup) {
    stt.warmup().catch((err: unknown) => log.warn(`warmup do STT falhou (segue sob demanda): ${errorMessage(err)}`));
  }

  // Rede/serviço instável não pode derrubar o servidor — logamos e seguimos.
  process.on('unhandledRejection', (reason) => {
    log.error('promise rejeitada sem tratamento (ignorado p/ manter o servidor no ar)', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('exceção não capturada (ignorado p/ manter o servidor no ar)', err);
  });
  const stopPurge = startCapturePurgeJob({
    db,
    captureDir,
    retentionDays: config.captureRetentionDays,
  });
  const renewNow = (): void => {
    subscriptions?.renewIfExpiring().catch((err: unknown) => {
      log.error('renovação de subscription falhou', err);
    });
  };
  renewNow();
  const renewTimer = setInterval(renewNow, SUBSCRIPTION_RENEW_INTERVAL_MS);
  renewTimer.unref();

  const shutdown = (signal: string): void => {
    log.info(`${signal} recebido — encerrando…`);
    clearInterval(renewTimer);
    stopPurge();
    voreo.stopWorker();
    eventQueue.stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
