import { Router, raw } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import { apiCors } from './api.js';
import { createLogger } from '../log.js';

/**
 * Ingest da captura de áudio feita pela extensão.
 *
 *   POST /api/capture/start      abre a captura, devolve captureId
 *   POST /api/capture/chunk      recebe bytes crus de áudio (octet-stream)
 *   POST /api/capture/heartbeat  sinal de vida (usado pra medir cobertura)
 *   POST /api/capture/stop       encerra e dispara a transcrição
 *
 * Os bytes são gravados em <captureDir>/<captureId>/<track>-<seq>.webm.
 */

const log = createLogger('routes/capture');

const MAX_CHUNKS_PER_MINUTE = 240; // trava anti-dreno de disco por captura

const startSchema = z.object({
  meetingCode: z.string().max(120).nullable().optional(),
  sessionId: z.string().uuid().nullable().optional(),
  startedAt: z.string().datetime({ offset: true }),
  mode: z.enum(['webrtc-tap', 'tab-capture']).default('webrtc-tap'),
  mimeType: z.string().max(120).default(''),
});

const chunkQuerySchema = z.object({
  captureId: z.string().uuid(),
  seq: z.coerce.number().int().nonnegative(),
  track: z.enum(['mic', 'remote']),
});

const heartbeatSchema = z.object({
  captureId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
  capturing: z.boolean(),
  inCall: z.boolean(),
  micActive: z.boolean(),
  remoteTracks: z.number().int().nonnegative(),
  bytesSent: z.number().int().nonnegative(),
});

const captionSchema = z.object({
  captureId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  speaker: z.string().min(1).max(120),
  text: z.string().min(1).max(5000),
  at: z.string().datetime({ offset: true }),
});

const stopSchema = z.object({
  captureId: z.string().uuid(),
  endedAt: z.string().datetime({ offset: true }),
  reason: z.enum(['call-ended', 'tab-closed', 'error']).default('call-ended'),
  totalChunks: z
    .object({ mic: z.number().int().nonnegative(), remote: z.number().int().nonnegative() })
    .optional(),
});

export interface CaptureRouterDeps {
  db: Db;
  captureDir: string;
  /** Chamado após /stop pra enfileirar a transcrição (async). */
  onCaptureStopped: (captureId: string) => void;
}

/** Zero-pad pro seq garantir ordenação lexicográfica dos arquivos. */
function padSeq(seq: number): string {
  return String(seq).padStart(6, '0');
}

export function createCaptureRouter(deps: CaptureRouterDeps): Router {
  const { db, captureDir, onCaptureStopped } = deps;
  const router = Router();

  // Rate limit simples em memória: chunks por captura por janela de 1 min.
  const rate = new Map<string, { windowStart: number; count: number }>();
  function allowChunk(captureId: string, nowMs: number): boolean {
    const entry = rate.get(captureId);
    if (!entry || nowMs - entry.windowStart >= 60_000) {
      rate.set(captureId, { windowStart: nowMs, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_CHUNKS_PER_MINUTE;
  }

  router.use('/api/capture', apiCors);

  router.post('/api/capture/start', (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'start inválido.', issues: parsed.error.issues });
      return;
    }
    const id = randomUUID();
    db.createCapture({
      id,
      sessionId: parsed.data.sessionId ?? null,
      meetingCode: parsed.data.meetingCode ?? null,
      mode: parsed.data.mode,
      mimeType: parsed.data.mimeType || null,
      startedAt: parsed.data.startedAt,
    });
    try {
      mkdirSync(join(captureDir, id), { recursive: true });
    } catch (err) {
      log.error(`falha ao criar pasta da captura ${id}`, err);
    }
    log.info(`captura iniciada: ${id} (meet=${parsed.data.meetingCode ?? '?'})`);
    res.status(200).json({ captureId: id });
  });

  // Bytes crus: raw() SÓ nesta rota, não globalmente.
  router.post(
    '/api/capture/chunk',
    raw({ type: 'application/octet-stream', limit: '25mb' }),
    (req, res) => {
      const parsed = chunkQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'query inválida (captureId, seq, track).' });
        return;
      }
      const { captureId, seq, track } = parsed.data;
      const capture = db.getCapture(captureId);
      if (!capture) {
        res.status(404).json({ error: 'captureId desconhecido.' });
        return;
      }
      if (!allowChunk(captureId, Date.now())) {
        res.status(429).json({ error: 'excesso de chunks — desacelere.' });
        return;
      }
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(204).end();
        return;
      }
      try {
        const file = join(captureDir, captureId, `${track}-${padSeq(seq)}.webm`);
        writeFileSync(file, body);
      } catch (err) {
        log.error(`falha ao gravar chunk ${track}-${seq} da captura ${captureId}`, err);
        res.status(500).json({ error: 'falha ao gravar chunk.' });
        return;
      }
      res.status(204).end();
    }
  );

  // Legenda do Meet (caminho principal de transcrição): cada fala fechada vira
  // uma linha. Não passa por STT — o texto já vem pronto do Google.
  router.post('/api/capture/caption', (req, res) => {
    const parsed = captionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'caption inválida.', issues: parsed.error.issues });
      return;
    }
    if (!db.getCapture(parsed.data.captureId)) {
      res.status(404).json({ error: 'captureId desconhecido.' });
      return;
    }
    db.addCaption(parsed.data);
    res.status(204).end();
  });

  router.post('/api/capture/heartbeat', (req, res) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'heartbeat inválido.' });
      return;
    }
    db.addHeartbeat(parsed.data);
    res.status(204).end();
  });

  router.post('/api/capture/stop', (req, res) => {
    const parsed = stopSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'stop inválido.' });
      return;
    }
    const { captureId, endedAt, reason } = parsed.data;
    const capture = db.getCapture(captureId);
    if (!capture) {
      res.status(404).json({ error: 'captureId desconhecido.' });
      return;
    }
    db.markCaptureStopped({ id: captureId, endedAt, stopReason: reason });
    rate.delete(captureId);
    log.info(`captura encerrada: ${captureId} (motivo=${reason}) — transcrição enfileirada.`);
    // 202: aceito, processamento assíncrono.
    res.status(202).json({ ok: true });
    onCaptureStopped(captureId);
  });

  return router;
}
