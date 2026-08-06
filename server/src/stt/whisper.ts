import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createLogger } from '../log.js';
import type { SttProvider, SttInput, SttResult, SttEntry } from './types.js';

/**
 * Provedor compatível com a API OpenAI /audio/transcriptions.
 *
 * Serve tanto pra Whisper local (faster-whisper-server, whisper.cpp server,
 * LocalAI) via STT_BASE_URL, quanto pra própria OpenAI. Whisper NÃO faz
 * diarization — a trilha remota volta como um bloco só (ainda dá pra ler;
 * a separação atendente/cliente vem das DUAS trilhas, não do diarize).
 */

const log = createLogger('stt/whisper');

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperResponse {
  text?: string;
  segments?: WhisperSegment[];
}

export class WhisperProvider implements SttProvider {
  readonly name = 'whisper';

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const audio = await readFile(input.filePath);
    const form = new FormData();
    const blob = new Blob([new Uint8Array(audio)], { type: 'audio/webm' });
    form.append('file', blob, basename(input.filePath));
    form.append('model', this.model);
    form.append('language', input.languageCode.split('-')[0] ?? 'pt');
    form.append('response_format', 'verbose_json');

    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const url = `${this.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
    const response = await this.fetchImpl(url, { method: 'POST', headers, body: form });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`Whisper HTTP ${response.status}: ${detail}`);
    }

    const json = (await response.json()) as WhisperResponse;
    const segments = json.segments ?? [];
    const entries: SttEntry[] =
      segments.length > 0
        ? segments.map((seg) => ({
            speaker: 'Falante',
            text: seg.text.trim(),
            startMs: Math.round(seg.start * 1000),
            endMs: Math.round(seg.end * 1000),
          }))
        : json.text
          ? [{ speaker: 'Falante', text: json.text.trim(), startMs: 0, endMs: 0 }]
          : [];

    log.info(`transcrição ok (${entries.length} segmentos)`);
    return { entries, raw: json };
  }
}
