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

/**
 * Em trechos de silêncio ou ruído o Whisper "alucina" marcadores como
 * "[Música]", "Legendado por...", "Obrigado." Filtramos os casos clássicos pra
 * não poluir a transcrição com texto que ninguém falou.
 */
const HALLUCINATIONS = [
  /^\[?\s*(música|music|musique|aplausos|applause|risos|laughter|silêncio|silence|ruído|inaudível|gritos?( de gol)?|torcida)\s*\]?[.!]?$/i,
  /^legenda(s|do|s? por)\b/i,
  /^subtitles? by\b/i,
  /^amara\.org$/i,
  /^♪+$/,
];

/**
 * Limpa marcadores que o Whisper inventa em silêncio/ruído e que vêm MISTURADOS
 * com fala real: "[Som de telefone]", "[MÚSICA]", "♪", "(Para o chão)".
 * Devolve o texto sem esses marcadores (ou vazio, se só tinha lixo).
 */
export function cleanText(text: string): string {
  return text
    .replace(/\[[^\]]{1,40}\]/g, ' ') // [Som de X], [MÚSICA]
    .replace(/\((?:som|músic|ru[íi]do|risos|aplausos)[^)]*\)/gi, ' ') // (Som de X)
    .replace(/♪+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function isHallucination(text: string): boolean {
  const t = text.trim();
  if (!t) return true;

  // Só marcadores entre colchetes: "[Música]", "[GRITOS DE GOL] [GRITOS DE GOL]"
  const semMarcadores = t.replace(/\[[^\]]{1,30}\]/g, '').trim();
  if (semMarcadores === '' && /\[/.test(t)) return true;

  if (HALLUCINATIONS.some((re) => re.test(t))) return true;

  // Loop de palavra repetida: "um, um, um, um, …" / "ai, ai, ai, ai, …"
  const palavras = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (palavras.length >= 6) {
    const unicas = new Set(palavras);
    // Poucas palavras distintas em muitas repetições = delírio, não fala.
    if (unicas.size <= 2) return true;
    const maisComum = Math.max(
      ...[...unicas].map((p) => palavras.filter((x) => x === p).length)
    );
    if (maisComum / palavras.length > 0.6) return true;
  }
  return false;
}

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
        // @ts-ignore  opcional: ver a mesma nota em stt/decode.ts. O catch
        // de quem chama já traduz a ausência numa mensagem legível.
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
      // Anti-alucinação: em silêncio/ruído o Whisper entra em loop
      // ("um, um, um…", "[GRITOS DE GOL]"). Estes parâmetros seguram isso:
      temperature: 0, // determinístico, sem "criatividade"
      no_repeat_ngram_size: 4, // proíbe repetir a mesma sequência de 4 tokens
      repetition_penalty: 1.2,
      condition_on_previous_text: false, // não arrasta o delírio pro trecho seguinte
    });

    const entries: SttEntry[] = [];
    if (result.chunks && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        if (isHallucination(chunk.text)) continue;
        const text = cleanText(chunk.text);
        if (!text) continue; // sobrou só marcador → descarta
        const startMs = Math.round((chunk.timestamp[0] ?? 0) * 1000);
        const endMs = Math.round((chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) * 1000);
        entries.push({ speaker: 'Falante', text, startMs, endMs });
      }
    } else {
      const text = cleanText(result.text);
      if (text && !isHallucination(result.text)) {
        entries.push({ speaker: 'Falante', text, startMs: 0, endMs: 0 });
      }
    }

    log.info(`transcrição local ok (${entries.length} trechos).`);
    return { entries };
  }
}
