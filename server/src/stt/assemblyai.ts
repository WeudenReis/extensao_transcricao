import { readFile } from 'node:fs/promises';
import { createLogger } from '../log.js';
import type { SttProvider, SttInput, SttResult, SttEntry } from './types.js';

/**
 * Provedor AssemblyAI (alternativa mais barata). Fluxo em 2 passos:
 * 1) upload do áudio -> upload_url
 * 2) cria o transcript (com speaker_labels) e faz polling até 'completed'.
 * Docs: https://www.assemblyai.com/docs
 */

const log = createLogger('stt/assemblyai');
const BASE = 'https://api.assemblyai.com/v2';
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 200; // ~10 min de teto

interface AaiUtterance {
  speaker: string;
  text: string;
  start: number; // ms
  end: number; // ms
  confidence?: number;
}

interface AaiTranscript {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  error?: string;
  utterances?: AaiUtterance[];
}

export class AssemblyAiProvider implements SttProvider {
  readonly name = 'assemblyai';

  constructor(
    private readonly apiKey: string,
    private readonly languageCode: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep
  ) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const audio = await readFile(input.filePath);
    const uploadUrl = await this.upload(new Uint8Array(audio));

    const created = (await this.json('POST', `${BASE}/transcript`, {
      audio_url: uploadUrl,
      speaker_labels: input.diarize,
      language_code: input.languageCode.toLowerCase(),
    })) as AaiTranscript;

    let current = created;
    for (let i = 0; i < MAX_POLLS && current.status !== 'completed'; i++) {
      if (current.status === 'error') {
        throw new Error(`AssemblyAI erro: ${current.error ?? 'desconhecido'}`);
      }
      await this.sleep(POLL_INTERVAL_MS);
      current = (await this.json('GET', `${BASE}/transcript/${created.id}`)) as AaiTranscript;
    }
    if (current.status !== 'completed') {
      throw new Error('AssemblyAI: transcrição não concluiu no tempo esperado.');
    }

    const utterances = current.utterances ?? [];
    const entries: SttEntry[] =
      utterances.length > 0
        ? utterances.map((u) => ({
            speaker: `Falante ${u.speaker}`,
            text: u.text.trim(),
            startMs: u.start,
            endMs: u.end,
            confidence: u.confidence,
          }))
        : current.text
          ? [{ speaker: 'Falante', text: current.text.trim(), startMs: 0, endMs: 0 }]
          : [];

    log.info(`transcrição ok (${entries.length} trechos)`);
    return { entries, raw: current };
  }

  private async upload(bytes: Uint8Array): Promise<string> {
    const response = await this.fetchImpl(`${BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: this.apiKey, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!response.ok) throw new Error(`AssemblyAI upload HTTP ${response.status}`);
    const data = (await response.json()) as { upload_url: string };
    return data.upload_url;
  }

  private async json(method: string, url: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`AssemblyAI ${method} ${url} HTTP ${response.status}`);
    return response.json();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
