import { Router } from 'express';
import { join } from 'node:path';
import { existsSync, createReadStream, statSync } from 'node:fs';
import type { Db } from '../db.js';
import type { AudioPipeline } from '../pipeline/audioTranscript.js';
import { apiCors } from './api.js';
import { createLogger } from '../log.js';
import { reviewPageHtml } from './reviewPage.js';

/**
 * Painel de revisão local: o atendente/admin VÊ a transcrição (e ouve o áudio)
 * ANTES de enviar pra Voreo. Envio é por botão (opt-in).
 *
 *   GET  /                         → página de revisão (HTML)
 *   GET  /api/captures             → lista
 *   GET  /api/captures/:id         → detalhe (transcript, cobertura, gaps)
 *   GET  /api/captures/:id/audio/:track  → áudio concatenado (mic|remote)
 *   POST /api/captures/:id/send-voreo     → envia pra Voreo
 */

const log = createLogger('routes/review');

export interface ReviewRouterDeps {
  db: Db;
  captureDir: string;
  pipeline: AudioPipeline;
}

export function createReviewRouter(deps: ReviewRouterDeps): Router {
  const { db, captureDir, pipeline } = deps;
  const router = Router();

  router.get('/', (_req, res) => {
    res.type('html').send(reviewPageHtml());
  });

  router.use('/api/captures', apiCors);

  router.get('/api/captures', (_req, res) => {
    const captures = db.listCaptures(100).map((c) => ({
      id: c.id,
      meetingCode: c.meeting_code,
      sessionId: c.session_id,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      status: c.status,
      coverageRatio: c.coverage_ratio,
      sttProvider: c.stt_provider,
      voreoStatus: c.voreo_status,
    }));
    res.json({ captures });
  });

  router.get('/api/captures/:id', (req, res) => {
    const c = db.getCapture(req.params.id);
    if (!c) {
      res.status(404).json({ error: 'captura não encontrada.' });
      return;
    }
    res.json({
      id: c.id,
      meetingCode: c.meeting_code,
      sessionId: c.session_id,
      startedAt: c.started_at,
      endedAt: c.ended_at,
      stopReason: c.stop_reason,
      status: c.status,
      coverageRatio: c.coverage_ratio,
      gaps: c.gaps_json ? JSON.parse(c.gaps_json) : [],
      sttProvider: c.stt_provider,
      voreoStatus: c.voreo_status,
      error: c.error,
      transcript: c.transcript_json ? JSON.parse(c.transcript_json) : [],
      hasAudio: {
        mic: existsSync(join(captureDir, c.id, 'mic.webm')),
        remote: existsSync(join(captureDir, c.id, 'remote.webm')),
      },
    });
  });

  router.get('/api/captures/:id/audio/:track', (req, res) => {
    const track = req.params.track === 'mic' ? 'mic' : 'remote';
    const file = join(captureDir, req.params.id, `${track}.webm`);
    if (!existsSync(file)) {
      res.status(404).json({ error: 'áudio não disponível.' });
      return;
    }
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Content-Length', statSync(file).size);
    createReadStream(file).pipe(res);
  });

  router.post('/api/captures/:id/reprocess', (req, res) => {
    const c = db.getCapture(req.params.id);
    if (!c) {
      res.status(404).json({ error: 'captura não encontrada.' });
      return;
    }
    db.setCaptureStatus(req.params.id, 'pending');
    pipeline.enqueue(req.params.id);
    log.info(`reprocessamento manual da captura ${req.params.id} enfileirado.`);
    res.json({ ok: true });
  });

  router.post('/api/captures/:id/send-voreo', async (req, res) => {
    const c = db.getCapture(req.params.id);
    if (!c) {
      res.status(404).json({ error: 'captura não encontrada.' });
      return;
    }
    const result = await pipeline.sendToVoreo(req.params.id);
    log.info(`envio manual à Voreo da captura ${req.params.id}: ${result.status}`);
    res.status(result.ok ? 200 : 502).json(result);
  });

  return router;
}
