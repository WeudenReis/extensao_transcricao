import { readFile } from 'node:fs/promises';
import { createLogger } from '../log.js';
import type { SttProvider, SttInput, SttResult, SttEntry } from './types.js';

/**
 * Provedor Deepgram (padrão). pt-BR nativo, diarization inclusa.
 *
 * Envia o arquivo de áudio (webm/opus) direto pro endpoint de pré-gravado.
 * Docs: https://developers.deepgram.com/reference/listen-file
 */

const log = createLogger('stt/deepgram');
const ENDPOINT = 'https://api.deepgram.com/v1/listen';

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
  punctuated_word?: string;
}

interface DeepgramResponse {
  results?: {
    channels?: {
      alternatives?: {
        transcript?: string;
        confidence?: number;
        words?: DeepgramWord[];
      }[];
    }[];
  };
}

export class DeepgramProvider implements SttProvider {
  readonly name = 'deepgram';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const audio = await readFile(input.filePath);
    const params = new URLSearchParams({
      model: this.model,
      language: input.languageCode,
      punctuate: 'true',
      smart_format: 'true',
    });
    if (input.diarize) params.set('diarize', 'true');

    const response = await this.fetchImpl(`${ENDPOINT}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        // O pipeline entrega .wav (PCM 16 kHz mono) — ver stt/decode.ts.
        'Content-Type': input.filePath.endsWith('.wav') ? 'audio/wav' : 'audio/webm',
      },
      // Uint8Array é aceito como BodyInit; evita depender de tipos de Buffer.
      body: new Uint8Array(audio),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`Deepgram HTTP ${response.status}: ${detail}`);
    }

    const json = (await response.json()) as DeepgramResponse;
    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    const words = alt?.words ?? [];
    const entries = input.diarize
      ? groupBySpeaker(words)
      : singleEntry(alt?.transcript ?? '', words);

    log.info(`transcrição ok (${entries.length} trechos, diarize=${input.diarize})`);
    return { entries, raw: json };
  }
}

/** Sem diarization: um único bloco com o transcript inteiro. */
function singleEntry(transcript: string, words: DeepgramWord[]): SttEntry[] {
  if (!transcript.trim()) return [];
  const startMs = words.length > 0 ? Math.round((words[0]?.start ?? 0) * 1000) : 0;
  const endMs =
    words.length > 0 ? Math.round((words[words.length - 1]?.end ?? 0) * 1000) : 0;
  return [{ speaker: 'Falante', text: transcript.trim(), startMs, endMs }];
}

/** Com diarization: agrupa palavras consecutivas do mesmo speaker. */
function groupBySpeaker(words: DeepgramWord[]): SttEntry[] {
  const entries: SttEntry[] = [];
  let current: SttEntry | null = null;
  let currentSpeaker: number | null = null;

  for (const word of words) {
    const speaker = word.speaker ?? 0;
    const text = word.punctuated_word ?? word.word;
    if (!current || speaker !== currentSpeaker) {
      if (current) entries.push(current);
      currentSpeaker = speaker;
      current = {
        speaker: `Falante ${speaker + 1}`,
        text,
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
        confidence: word.confidence,
      };
    } else {
      current.text += ` ${text}`;
      current.endMs = Math.round(word.end * 1000);
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '(sem corpo)';
  }
}
