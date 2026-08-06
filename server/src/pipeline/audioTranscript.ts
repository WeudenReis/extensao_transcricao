import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, CaptureRow, CaptureHeartbeatRow } from '../db.js';
import type { SttProvider, SttEntry } from '../stt/index.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Transforma os chunks de áudio de uma captura em transcrição.
 *
 * Passos: concatena os chunks de cada trilha (mic/remote) → transcreve cada uma
 * → funde num transcript único ordenado por tempo → calcula a COBERTURA
 * (métrica anti-adulteração) → grava. Envio pra Voreo é opt-in (revisão antes).
 */

const log = createLogger('pipeline/audio');

const GAP_THRESHOLD_MS = 20_000; // buraco relevante entre sinais de captura

export interface MergedEntry {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface Gap {
  fromMs: number;
  toMs: number;
  reason: 'no-heartbeat' | 'capturing-off-in-call';
}

export interface Coverage {
  ratio: number; // 0..1
  gaps: Gap[];
  callDurationMs: number;
}

// ─── Funções puras (testáveis isoladamente) ──────────────────────────────────

/**
 * Concatena chunks webm/opus do MESMO MediaRecorder por bytes.
 * Só o primeiro chunk traz o header/inicialização; os demais são continuação,
 * então a concatenação binária em ordem de seq produz um arquivo tocável.
 */
export function concatChunks(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

/** Renomeia falantes da trilha remota: 1 falante → "Cliente"; vários → mantém. */
export function labelRemote(entries: SttEntry[]): MergedEntry[] {
  const speakers = new Set(entries.map((e) => e.speaker));
  const single = speakers.size <= 1;
  return entries.map((e) => ({
    speaker: single ? 'Cliente' : e.speaker,
    text: e.text,
    startMs: e.startMs,
    endMs: e.endMs,
  }));
}

export function labelMic(entries: SttEntry[]): MergedEntry[] {
  return entries.map((e) => ({
    speaker: 'Atendente',
    text: e.text,
    startMs: e.startMs,
    endMs: e.endMs,
  }));
}

/** Funde as duas trilhas ordenando por início da fala. */
export function mergeTracks(mic: MergedEntry[], remote: MergedEntry[]): MergedEntry[] {
  return [...mic, ...remote].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Cobertura anti-adulteração: compara a duração da chamada com os intervalos
 * efetivamente cobertos pelos heartbeats. Buraco = período sem heartbeat
 * (>20s) ou heartbeat com inCall=true mas capturing=false.
 */
export function computeCoverage(
  startedAt: string,
  endedAt: string | null,
  heartbeats: CaptureHeartbeatRow[]
): Coverage {
  const start = Date.parse(startedAt);
  const endBase = endedAt ? Date.parse(endedAt) : start;
  const hbTimes = heartbeats.map((h) => Date.parse(h.at)).filter((t) => !Number.isNaN(t));
  const end = Math.max(endBase, ...(hbTimes.length ? hbTimes : [endBase]));
  const callDurationMs = Math.max(0, end - start);
  if (callDurationMs === 0) {
    return { ratio: heartbeats.length > 0 ? 1 : 0, gaps: [], callDurationMs: 0 };
  }

  const sorted = [...heartbeats].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const gaps: Gap[] = [];
  let coveredMs = 0;

  // Trecho inicial: do começo da chamada até o 1º heartbeat.
  const firstMs = sorted.length ? Date.parse(sorted[0]!.at) - start : callDurationMs;
  if (firstMs > GAP_THRESHOLD_MS) {
    gaps.push({ fromMs: 0, toMs: firstMs, reason: 'no-heartbeat' });
  } else {
    coveredMs += Math.max(0, firstMs);
  }

  for (let i = 0; i < sorted.length; i++) {
    const hb = sorted[i]!;
    const t = Date.parse(hb.at) - start;
    const nextT = i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.at) - start : callDurationMs;
    const span = Math.max(0, nextT - t);

    if (hb.capturing === 0 && hb.in_call === 1) {
      gaps.push({ fromMs: t, toMs: nextT, reason: 'capturing-off-in-call' });
    } else if (span > GAP_THRESHOLD_MS) {
      // Intervalo grande demais entre heartbeats: perdemos sinal no meio.
      gaps.push({ fromMs: t, toMs: nextT, reason: 'no-heartbeat' });
    } else {
      coveredMs += span;
    }
  }

  const ratio = Math.max(0, Math.min(1, coveredMs / callDurationMs));
  return { ratio: Number(ratio.toFixed(4)), gaps, callDurationMs };
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface AudioPipelineDeps {
  db: Db;
  captureDir: string;
  stt: SttProvider | null;
  language: string;
  autoSendVoreo: boolean;
  voreoWebhookUrl: string | undefined;
  voreoApiKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export class AudioPipeline {
  private readonly deps: AudioPipelineDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly inFlight = new Set<string>();
  private queue: string[] = [];
  private draining = false;

  constructor(deps: AudioPipelineDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Enfileira uma captura pra processar (não bloqueia o request de /stop). */
  enqueue(captureId: string): void {
    if (this.inFlight.has(captureId) || this.queue.includes(captureId)) return;
    this.queue.push(captureId);
    void this.drain();
  }

  /** Retoma capturas que ficaram 'pending' (ex.: restart no meio). */
  resumePending(): void {
    for (const capture of this.deps.db.pendingCaptures()) this.enqueue(capture.id);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        this.inFlight.add(id);
        try {
          await this.processCapture(id);
        } catch (err) {
          log.error(`falha ao processar captura ${id}`, err);
          this.deps.db.setCaptureStatus(id, 'failed', errorMessage(err));
        } finally {
          this.inFlight.delete(id);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async processCapture(captureId: string): Promise<void> {
    const { db } = this.deps;
    const capture = db.getCapture(captureId);
    if (!capture) {
      log.warn(`captura ${captureId} não encontrada — ignorando.`);
      return;
    }
    db.setCaptureStatus(captureId, 'transcribing');

    // 1) Concatena chunks de cada trilha.
    const micFile = this.assembleTrack(captureId, 'mic');
    const remoteFile = this.assembleTrack(captureId, 'remote');

    // 2) Transcreve (se houver provedor configurado).
    let mic: MergedEntry[] = [];
    let remote: MergedEntry[] = [];
    const providerName = this.deps.stt?.name ?? 'none';

    if (this.deps.stt) {
      if (micFile) {
        const r = await this.deps.stt.transcribe({
          filePath: micFile,
          languageCode: this.deps.language,
          diarize: false,
        });
        mic = labelMic(r.entries);
      }
      if (remoteFile) {
        const r = await this.deps.stt.transcribe({
          filePath: remoteFile,
          languageCode: this.deps.language,
          diarize: true,
        });
        remote = labelRemote(r.entries);
      }
    } else {
      log.warn(`captura ${captureId}: sem STT configurado — só o áudio fica disponível.`);
    }

    // 3) Funde e 4) calcula cobertura.
    const transcript = mergeTracks(mic, remote);
    const coverage = computeCoverage(
      capture.started_at,
      capture.ended_at,
      db.listHeartbeats(captureId)
    );

    // 5) Grava.
    db.saveCaptureTranscript({
      id: captureId,
      transcriptJson: JSON.stringify(transcript),
      coverageRatio: coverage.ratio,
      gapsJson: JSON.stringify(coverage.gaps),
      sttProvider: providerName,
      status: 'ready-for-review',
    });
    log.info(
      `captura ${captureId} pronta: ${transcript.length} falas, cobertura ${(coverage.ratio * 100).toFixed(0)}%, ${coverage.gaps.length} gap(s).`
    );

    // 6) Voreo é opt-in: só envia sozinho se AUTO_SEND_VOREO=true.
    if (this.deps.autoSendVoreo) {
      await this.sendToVoreo(captureId);
    }
  }

  /** Concatena os chunks de uma trilha; devolve o caminho do arquivo ou null. */
  private assembleTrack(captureId: string, track: 'mic' | 'remote'): string | null {
    const dir = join(this.deps.captureDir, captureId);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${track}-`) && f.endsWith('.webm') && f !== `${track}.webm`)
      .sort(); // zero-pad garante ordem correta
    if (files.length === 0) return null;
    const buffers = files.map((f) => readFileSync(join(dir, f)));
    const out = join(dir, `${track}.webm`);
    writeFileSync(out, concatChunks(buffers));
    return out;
  }

  /**
   * Envio opt-in pra Voreo. Chamado pelo botão da página de revisão (ou auto).
   * POST direto + status na captura — a fila durável é do caminho Meet-API.
   */
  async sendToVoreo(captureId: string): Promise<{ ok: boolean; status: string }> {
    const { db } = this.deps;
    const capture = db.getCapture(captureId);
    if (!capture || !capture.transcript_json) {
      return { ok: false, status: 'sem-transcricao' };
    }
    const payload = this.buildVoreoPayload(capture);

    if (!this.deps.voreoWebhookUrl) {
      db.setCaptureVoreoStatus(captureId, 'skipped-no-url');
      log.info(`captura ${captureId}: VOREO_WEBHOOK_URL vazio — envio pulado (modo dev).`);
      return { ok: false, status: 'skipped-no-url' };
    }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.deps.voreoApiKey) headers.Authorization = `Bearer ${this.deps.voreoApiKey}`;
      const response = await this.fetchImpl(this.deps.voreoWebhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Voreo HTTP ${response.status}`);
      db.setCaptureVoreoStatus(captureId, 'sent');
      db.setCaptureStatus(captureId, 'sent');
      log.info(`captura ${captureId} enviada à Voreo.`);
      return { ok: true, status: 'sent' };
    } catch (err) {
      const status = `failed: ${errorMessage(err)}`;
      db.setCaptureVoreoStatus(captureId, status);
      log.warn(`captura ${captureId}: falha ao enviar à Voreo — ${errorMessage(err)}`);
      return { ok: false, status };
    }
  }

  private buildVoreoPayload(capture: CaptureRow): Record<string, unknown> {
    const transcript = capture.transcript_json
      ? (JSON.parse(capture.transcript_json) as MergedEntry[])
      : [];
    const gaps = capture.gaps_json ? (JSON.parse(capture.gaps_json) as Gap[]) : [];
    // Resolve sessionId: o gravado no start ou, se faltar, pelo vínculo do meet.
    let sessionId = capture.session_id;
    if (!sessionId && capture.meeting_code) {
      const link = this.deps.db.findLinkByMeetingCode(capture.meeting_code);
      sessionId = link?.session_id ?? null;
    }
    return {
      source: 'chatpro-audio-capture',
      sessionId,
      meetingCode: capture.meeting_code,
      startTime: capture.started_at,
      endTime: capture.ended_at,
      sttProvider: capture.stt_provider,
      coverage: { ratio: capture.coverage_ratio, gaps },
      transcript,
    };
  }
}
