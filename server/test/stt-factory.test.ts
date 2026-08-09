import { describe, it, expect } from 'vitest';
import { createSttProvider } from '../src/stt/index.js';
import { loadConfig, type Config } from '../src/config.js';

/**
 * Monta um Config real via loadConfig em vez de escrever o objeto à mão.
 * O objeto manual ficava desatualizado a cada campo novo — e o tsc nem via,
 * porque a pasta test/ estava fora do type-check.
 */
function baseConfig(overrides: Partial<Config>): Config {
  return { ...loadConfig({}), ...overrides };
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
