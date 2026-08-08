import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createLogger } from '../log.js';

/**
 * Decodifica um arquivo de áudio (webm/opus) para PCM mono 16 kHz float32,
 * usando o ffmpeg baixado pelo pacote ffmpeg-static (sem instalação manual).
 *
 * O Whisper (transformers.js) espera exatamente Float32Array a 16 kHz mono.
 *
 * `ffmpeg-static` é carregado sob demanda porque hoje ele é OPCIONAL: pesa
 * ~80 MB e só serve ao caminho antigo de captura de áudio (STT_PROVIDER=local).
 * Com o Recall a transcrição já vem pronta, então a imagem de deploy não
 * precisa carregar isso. Import estático faria o servidor nem subir sem o
 * pacote instalado.
 */

const log = createLogger('stt/decode');

let ffmpegPathCache: string | null | undefined;

async function acharFfmpeg(): Promise<string | null> {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  try {
    const mod = (await import('ffmpeg-static')) as unknown as { default?: string };
    ffmpegPathCache = (mod.default ?? (mod as unknown as string)) || null;
  } catch {
    ffmpegPathCache = null;
  }
  return ffmpegPathCache;
}

export async function decodeToPcm16kMono(filePath: string): Promise<Float32Array> {
  const ffmpegPath = await acharFfmpeg();
  if (!ffmpegPath) {
    throw new Error(
      'ffmpeg-static não está instalado. Ele é opcional: só o caminho antigo de ' +
        'captura de áudio (STT_PROVIDER=local) precisa dele. Rode `npm install ffmpeg-static`.'
    );
  }

  return new Promise<Float32Array>((resolve, reject) => {
    // Só corta ronco fora da faixa da voz. NADA de loudnorm/normalização aqui:
    // amplificar um áudio quase mudo transforma ruído de fundo em "voz" e o
    // Whisper ALUCINA conversas inteiras (aconteceu: 6 min de texto inventado
    // a partir de silêncio). O ganho é aplicado depois, só nos trechos de fala.
    const filtros = 'highpass=f=70';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-af', filtros,
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

export const SAMPLE_RATE = 16000;

/**
 * Junta os pedaços do MediaRecorder e devolve o áudio em PCM.
 *
 * COMO: cola os .webm byte a byte num arquivo temporário e manda UMA passada de
 * ffmpeg. Só o primeiro pedaço traz o cabeçalho, e os seguintes são continuação
 * do mesmo fluxo — o ffmpeg lê tudo (medido: 31 pedaços → 154,9 s).
 *
 * NÃO tente decodificar pedaço a pedaço: do segundo em diante não há cabeçalho e
 * cada um falha isoladamente (rendia 4 s de 155 s).
 */
export async function decodeChunksToPcm(filePaths: string[]): Promise<Float32Array> {
  if (filePaths.length === 0) return new Float32Array(0);

  const joined = filePaths[0]!.replace(/-\d+\.webm$/, '') + '-joined.webm';
  writeFileSync(joined, Buffer.concat(filePaths.map((p) => readFileSync(p))));
  try {
    const pcm = await decodeToPcm16kMono(joined);
    log.info(
      `áudio montado: ${filePaths.length} pedaços → ${(pcm.length / SAMPLE_RATE).toFixed(1)}s`
    );
    return pcm;
  } finally {
    try {
      rmSync(joined, { force: true });
    } catch {
      /* temporário — ignorar */
    }
  }
}

/** RMS do sinal: perto de 0 = silêncio (usado pra avisar no log). */
export function medirVolume(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let soma = 0;
  for (const v of pcm) soma += v * v;
  return Math.sqrt(soma / pcm.length);
}

/**
 * Escreve PCM float32 como WAV PCM 16 bits mono 16 kHz.
 * WAV é trivialmente válido: toca no navegador e é aceito por qualquer STT.
 */
export function writeWav(pcm: Float32Array, outPath: string): void {
  const dataBytes = pcm.length * 2; // 16 bits por amostra
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // tamanho do bloco fmt
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits por amostra
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  writeFileSync(outPath, buffer);
}
