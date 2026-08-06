import { createLogger } from '../log.js';
import type { SttProvider, SttInput, SttResult, SttEntry } from './types.js';
import { decodeToPcm16kMono } from './decode.js';

/**
 * Transcrição 100% LOCAL e GRATUITA com Whisper via transformers.js.
 *
 * - Sem conta, sem chave, sem nuvem, sem custo por minuto.
 * - O modelo é baixado uma única vez (cache local) e roda em CPU (onnxruntime).
 * - Áudio decodificado por ffmpeg-static; inferência em JS/WASM.
 *
 * Modelos (STT_MODEL): 'Xenova/whisper-small' (padrão, melhor pt-BR) ou
 * 'Xenova/whisper-base' (mais rápido, menos preciso) / 'Xenova/whisper-tiny'.
 */

const log = createLogger('stt/local');

// Tipagem mínima da saída do pipeline (evita `any` do pacote dinâmico).
interface AsrChunk {
  timestamp: [number | null, number | null];
  text: string;
}
interface AsrResult {
  text: string;
  chunks?: AsrChunk[];
}
type AsrPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<AsrResult>;

export class LocalWhisperProvider implements SttProvider {
  readonly name = 'local';
  private pipelinePromise: Promise<AsrPipeline> | null = null;

  constructor(
    private readonly model: string,
    private readonly cacheDir: string
  ) {}

  /** Carrega o pipeline uma única vez (baixa o modelo no primeiro uso). */
  private async getPipeline(): Promise<AsrPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const mod = (await import('@xenova/transformers')) as unknown as {
          pipeline: (task: string, model: string) => Promise<AsrPipeline>;
          env: { cacheDir?: string; allowLocalModels?: boolean };
        };
        mod.env.cacheDir = this.cacheDir;
        log.info(`carregando modelo ${this.model} (baixa na 1ª vez; cache em ${this.cacheDir})…`);
        const pipe = await mod.pipeline('automatic-speech-recognition', this.model);
        log.info('modelo Whisper carregado (local, gratuito).');
        return pipe;
      })();
    }
    return this.pipelinePromise;
  }

  /**
   * Baixa/carrega o modelo já no boot, em vez de na 1ª chamada real. Assim a
   * primeira reunião não fica esperando o download de ~465MB.
   */
  async warmup(): Promise<void> {
    await this.getPipeline();
  }

  async transcribe(input: SttInput): Promise<SttResult> {
    const audio = await decodeToPcm16kMono(input.filePath);
    if (audio.length === 0) return { entries: [] };

    const pipe = await this.getPipeline();
    const language = (input.languageCode.split('-')[0] || 'pt').toLowerCase();
    const result = await pipe(audio, {
      task: 'transcribe',
      language,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });

    const entries: SttEntry[] = [];
    if (result.chunks && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        const text = chunk.text.trim();
        if (!text) continue;
        const startMs = Math.round((chunk.timestamp[0] ?? 0) * 1000);
        const endMs = Math.round((chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) * 1000);
        entries.push({ speaker: 'Falante', text, startMs, endMs });
      }
    } else if (result.text.trim()) {
      entries.push({ speaker: 'Falante', text: result.text.trim(), startMs: 0, endMs: 0 });
    }

    log.info(`transcrição local ok (${entries.length} trechos).`);
    return { entries };
  }
}
