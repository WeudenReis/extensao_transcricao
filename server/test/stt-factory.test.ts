import { describe, it, expect } from 'vitest';
import { createSttProvider } from '../src/stt/index.js';
import type { Config } from '../src/config.js';

function baseConfig(overrides: Partial<Config>): Config {
  return {
    googleClientId: 'x',
    googleClientSecret: 'x',
    googleRedirectUri: 'http://localhost:3333/oauth/callback',
    googlePubsubTopic: undefined,
    pubsubVerificationAudience: undefined,
    pubsubServiceAccount: undefined,
    allowInsecurePubsub: false,
    voreoWebhookUrl: undefined,
    voreoApiKey: undefined,
    port: 3333,
    databasePath: ':memory:',
    tokenEncryptionKey: undefined,
    sttProvider: 'deepgram',
    sttApiKey: undefined,
    sttModel: undefined,
    sttLanguage: 'pt-BR',
    sttBaseUrl: undefined,
    captureRetentionDays: 7,
    autoSendVoreo: false,
    ...overrides,
  };
}

describe('factory de provedor de STT', () => {
  it('retorna null com STT_PROVIDER=none', () => {
    expect(createSttProvider(baseConfig({ sttProvider: 'none' }))).toBeNull();
  });

  it('retorna null quando deepgram está sem STT_API_KEY (modo dev)', () => {
    expect(createSttProvider(baseConfig({ sttProvider: 'deepgram', sttApiKey: undefined }))).toBeNull();
  });

  it('cria o provedor Deepgram quando há chave', () => {
    const provider = createSttProvider(baseConfig({ sttProvider: 'deepgram', sttApiKey: 'k' }));
    expect(provider?.name).toBe('deepgram');
  });

  it('retorna null quando whisper está sem STT_BASE_URL', () => {
    expect(createSttProvider(baseConfig({ sttProvider: 'whisper', sttBaseUrl: undefined }))).toBeNull();
  });

  it('cria o provedor Whisper quando há base URL', () => {
    const provider = createSttProvider(
      baseConfig({ sttProvider: 'whisper', sttBaseUrl: 'http://localhost:8000/v1' })
    );
    expect(provider?.name).toBe('whisper');
  });
});
