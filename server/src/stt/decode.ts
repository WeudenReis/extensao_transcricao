import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { createLogger } from '../log.js';

/**
 * Decodifica um arquivo de áudio (webm/opus) para PCM mono 16 kHz float32,
 * usando o ffmpeg baixado pelo pacote ffmpeg-static (sem instalação manual).
 *
 * O Whisper (transformers.js) espera exatamente Float32Array a 16 kHz mono.
 */

const log = createLogger('stt/decode');

const ffmpegPath: string | null = ffmpegStatic as unknown as string | null;

export async function decodeToPcm16kMono(filePath: string): Promise<Float32Array> {
  if (!ffmpegPath) throw new Error('ffmpeg-static não disponível.');

  return new Promise<Float32Array>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-f', 'f32le', // PCM float32 little-endian cru
      '-acodec', 'pcm_f32le',
      '-ac', '1', // mono
      '-ar', '16000', // 16 kHz
      'pipe:1',
    ];
    const proc = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errChunks).toString('utf8').slice(0, 300);
        reject(new Error(`ffmpeg saiu com código ${code}: ${detail}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      // Alinha a múltiplo de 4 bytes (float32) por segurança.
      const usableBytes = raw.length - (raw.length % 4);
      const samples = new Float32Array(usableBytes / 4);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = raw.readFloatLE(i * 4);
      }
      log.debug(`decodificado ${filePath}: ${samples.length} amostras (${(samples.length / 16000).toFixed(1)}s)`);
      resolve(samples);
    });
  });
}
