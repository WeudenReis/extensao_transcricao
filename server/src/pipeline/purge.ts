import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { createLogger } from '../log.js';

/**
 * Expurgo LGPD: áudio bruto é dado sensível de cliente. Passado o prazo de
 * retenção, apagamos os arquivos de áudio das capturas — o TRANSCRITO (texto
 * já minimizado) permanece no banco para consulta. Roda no boot e a cada 24 h.
 */

const log = createLogger('pipeline/purge');
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeDeps {
  db: Db;
  captureDir: string;
  retentionDays: number;
  now?: () => Date;
}

export function purgeOldCaptureAudio(deps: PurgeDeps): number {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const cutoff = now - deps.retentionDays * DAY_MS;
  let removed = 0;
  for (const capture of deps.db.listCaptures(1000)) {
    const startedMs = Date.parse(capture.started_at);
    if (Number.isNaN(startedMs) || startedMs >= cutoff) continue;
    const dir = join(deps.captureDir, capture.id);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        log.error(`falha ao apagar áudio da captura ${capture.id}`, err);
      }
    }
  }
  if (removed > 0) log.info(`expurgo: áudio de ${removed} captura(s) antiga(s) apagado (transcrito mantido).`);
  return removed;
}

/** Agenda o expurgo (boot + a cada 24 h). Retorna a função de parada. */
export function startCapturePurgeJob(deps: PurgeDeps): () => void {
  try {
    purgeOldCaptureAudio(deps);
  } catch (err) {
    log.error('expurgo inicial falhou', err);
  }
  const timer = setInterval(() => {
    try {
      purgeOldCaptureAudio(deps);
    } catch (err) {
      log.error('expurgo periódico falhou', err);
    }
  }, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
