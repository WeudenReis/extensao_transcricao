import { join, dirname, resolve } from 'node:path';
import type { Config } from '../config.js';
import { createLogger } from '../log.js';
import type { SttProvider } from './types.js';
import { DeepgramProvider } from './deepgram.js';
import { AssemblyAiProvider } from './assemblyai.js';
import { WhisperProvider } from './whisper.js';
import { LocalWhisperProvider } from './local.js';

export type { SttProvider, SttResult, SttEntry, SttInput } from './types.js';

const log = createLogger('stt');

const DEFAULT_MODELS: Record<string, string> = {
  deepgram: 'nova-3',
  assemblyai: 'best',
  whisper: 'whisper-1',
  // 'small' erra bem menos que 'base' em pt-BR. Como a transcrição roda depois
  // da chamada, vale trocar velocidade por precisão.
  local: 'Xenova/whisper-small',
};

/**
 * Monta o provedor de STT a partir da config.
 *
 * Retorna `null` em "modo dev": STT_PROVIDER='none', ou um provedor que exige
 * chave sem STT_API_KEY. Nesse caso o pipeline não transcreve (marca a captura
 * como 'ready-for-review' sem texto) — o áudio fica gravado pra você ouvir e
 * conferir que a captura funciona, e basta configurar a chave depois.
 */
export function createSttProvider(config: Config): SttProvider | null {
  const model = config.sttModel ?? DEFAULT_MODELS[config.sttProvider] ?? 'default';

  switch (config.sttProvider) {
    case 'none':
      log.warn('STT_PROVIDER=none — captura grava o áudio mas não transcreve.');
      return null;

    case 'local': {
      // 100% gratuito e offline: Whisper via transformers.js (baixa o modelo
      // uma vez e roda em CPU). Cache dos modelos junto ao banco.
      const cacheDir = join(dirname(resolve(config.databasePath)), 'models');
      log.info('STT local (gratuito) — Whisper via transformers.js.');
      return new LocalWhisperProvider(model, cacheDir);
    }

    case 'deepgram':
      if (!config.sttApiKey) {
        log.warn('STT_PROVIDER=deepgram sem STT_API_KEY — modo dev (sem transcrição). Configure a chave.');
        return null;
      }
      return new DeepgramProvider(config.sttApiKey, model);

    case 'assemblyai':
      if (!config.sttApiKey) {
        log.warn('STT_PROVIDER=assemblyai sem STT_API_KEY — modo dev (sem transcrição).');
        return null;
      }
      return new AssemblyAiProvider(config.sttApiKey, config.sttLanguage);

    case 'whisper':
      if (!config.sttBaseUrl) {
        log.warn('STT_PROVIDER=whisper sem STT_BASE_URL — modo dev (sem transcrição).');
        return null;
      }
      return new WhisperProvider(config.sttBaseUrl, model, config.sttApiKey);

    default:
      return null;
  }
}
