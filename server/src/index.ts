import express from 'express';
import { loadConfig, ConfigError } from './config.js';
import { Db } from './db.js';
import { GoogleAuth, createOAuthRouter } from './google/auth.js';
import { MeetClient } from './google/meet.js';
import { EventsClient, SubscriptionManager } from './google/events.js';
import { TranscriptPipeline } from './pipeline/transcript.js';
import { EventQueueWorker } from './pipeline/eventQueue.js';
import { VoreoClient } from './voreo/client.js';
import { createApiRouter } from './routes/api.js';
import { createPubSubRouter } from './routes/pubsub.js';
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

  const app = express();
  app.use(express.json({ limit: '2mb' }));
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

  const server = app.listen(config.port, () => {
    log.info(`servidor ouvindo em http://localhost:${config.port}`);
    log.info(`OAuth Google: http://localhost:${config.port}/oauth/start`);
    log.info(`Webhook Pub/Sub: POST http://localhost:${config.port}/webhooks/pubsub`);
  });

  // Tarefas de startup
  voreo.startWorker();
  eventQueue.startWorker();
  eventQueue.poke(); // retoma eventos pendentes que sobraram de antes do restart
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
