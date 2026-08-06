import { createLogger } from '../log.js';

/**
 * Detecção de fala (VAD) — a proteção mais importante contra alucinação.
 *
 * POR QUE EXISTE (caso real de produção): numa reunião de 6 minutos em que o
 * atendente falou UMA frase, o Whisper recebeu ~6 min de quase-silêncio e
 * inventou uma conversa inteira, plausível e totalmente falsa. Transcrição
 * fabricada é pior que transcrição vazia — iria para a Voreo como se fosse real.
 *
 * Solução: só mandamos ao Whisper os trechos que REALMENTE têm fala. O silêncio
 * nunca chega nele, então não há do que alucinar. Os tempos são remapeados
 * depois para a linha do tempo original da reunião.
 */

const log = createLogger('stt/vad');

export const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 amostras
const PAD_MS = 300; // margem antes/depois pra não cortar início/fim de palavra
const MERGE_GAP_MS = 600; // junta trechos separados por pausas curtas
const MIN_SEG_MS = 250; // descarta estalos
const MIN_TOTAL_MS = 800; // abaixo disso, consideramos que não houve fala
const PISO_ABSOLUTO = 0.004; // nada abaixo disso é fala, por mais "alto" que pareça

export interface Segmento {
  inicio: number; // índice de amostra
  fim: number;
}

export interface ResultadoVad {
  /** PCM só com os trechos de fala, concatenados. */
  fala: Float32Array;
  /** Mapa pra converter tempo do áudio reduzido → tempo real da reunião. */
  mapa: { deMs: number; paraMs: number }[];
  totalFalaMs: number;
  duracaoOriginalMs: number;
}

function rmsDoQuadro(pcm: Float32Array, ini: number, fim: number): number {
  let soma = 0;
  for (let i = ini; i < fim; i++) {
    const v = pcm[i] ?? 0;
    soma += v * v;
  }
  return Math.sqrt(soma / Math.max(1, fim - ini));
}

/** Percentil simples (0..1) de um vetor já copiado. */
function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const ord = [...valores].sort((a, b) => a - b);
  const i = Math.min(ord.length - 1, Math.max(0, Math.floor(p * ord.length)));
  return ord[i] ?? 0;
}

/**
 * Acha os trechos com fala. O limiar é ADAPTATIVO: medimos o piso de ruído do
 * próprio áudio (percentil 20) e exigimos que a fala esteja bem acima dele.
 */
export function detectarFala(pcm: Float32Array): Segmento[] {
  const nQuadros = Math.floor(pcm.length / FRAME);
  if (nQuadros === 0) return [];

  const energias: number[] = new Array(nQuadros);
  for (let q = 0; q < nQuadros; q++) {
    energias[q] = rmsDoQuadro(pcm, q * FRAME, (q + 1) * FRAME);
  }

  const pisoRuido = percentil(energias, 0.2);
  const pico = percentil(energias, 0.99);
  // Limiar entre o piso de ruído e o pico, nunca abaixo do piso absoluto.
  const limiar = Math.max(PISO_ABSOLUTO, pisoRuido * 3.5, pico * 0.12);

  const padQuadros = Math.round(PAD_MS / FRAME_MS);
  const gapQuadros = Math.round(MERGE_GAP_MS / FRAME_MS);

  // 1) Acha os trechos com energia SEM margem ainda.
  const brutos: Segmento[] = [];
  let q = 0;
  while (q < nQuadros) {
    if ((energias[q] ?? 0) >= limiar) {
      let fim = q;
      let silencio = 0;
      let p = q;
      while (p < nQuadros && silencio <= gapQuadros) {
        if ((energias[p] ?? 0) >= limiar) {
          fim = p;
          silencio = 0;
        } else {
          silencio++;
        }
        p++;
      }
      brutos.push({ inicio: q * FRAME, fim: (fim + 1) * FRAME });
      q = p;
    } else {
      q++;
    }
  }

  // 2) Descarta curtos ANTES de aplicar margem — senão um estalo de 25ms
  //    viraria 625ms com o padding e passaria pelo filtro.
  const minAmostras = (MIN_SEG_MS * SAMPLE_RATE) / 1000;
  const reais = brutos.filter((s) => s.fim - s.inicio >= minAmostras);

  // 3) Agora sim aplica a margem e junta sobreposições.
  const pad = padQuadros * FRAME;
  const segs: Segmento[] = [];
  for (const s of reais) {
    const comMargem = {
      inicio: Math.max(0, s.inicio - pad),
      fim: Math.min(nQuadros * FRAME, s.fim + pad),
    };
    const ultimo = segs[segs.length - 1];
    if (ultimo && comMargem.inicio <= ultimo.fim) {
      ultimo.fim = Math.max(ultimo.fim, comMargem.fim);
    } else {
      segs.push(comMargem);
    }
  }
  return segs;
}

/** Monta o PCM só com fala e o mapa de tempos. */
export function extrairFala(pcm: Float32Array): ResultadoVad {
  const duracaoOriginalMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);
  const segs = detectarFala(pcm);

  const total = segs.reduce((s, x) => s + (x.fim - x.inicio), 0);
  const fala = new Float32Array(total);
  const mapa: { deMs: number; paraMs: number }[] = [];
  let off = 0;
  for (const s of segs) {
    mapa.push({
      deMs: Math.round((off / SAMPLE_RATE) * 1000),
      paraMs: Math.round((s.inicio / SAMPLE_RATE) * 1000),
    });
    fala.set(pcm.subarray(s.inicio, s.fim), off);
    off += s.fim - s.inicio;
  }

  const totalFalaMs = Math.round((total / SAMPLE_RATE) * 1000);
  log.info(
    `VAD: ${segs.length} trecho(s) de fala, ${(totalFalaMs / 1000).toFixed(1)}s de ` +
      `${(duracaoOriginalMs / 1000).toFixed(1)}s (${Math.round((100 * totalFalaMs) / Math.max(1, duracaoOriginalMs))}%)`
  );
  return { fala, mapa, totalFalaMs, duracaoOriginalMs };
}

/** Houve fala suficiente pra valer a pena transcrever? */
export function temFala(r: ResultadoVad): boolean {
  return r.totalFalaMs >= MIN_TOTAL_MS;
}

/** Converte um tempo do áudio reduzido de volta pra linha do tempo real. */
export function remapearMs(ms: number, mapa: { deMs: number; paraMs: number }[]): number {
  let escolhido = mapa[0];
  for (const m of mapa) {
    if (m.deMs <= ms) escolhido = m;
    else break;
  }
  if (!escolhido) return ms;
  return escolhido.paraMs + (ms - escolhido.deMs);
}

/** Ganho suave aplicado SÓ na fala (nunca no silêncio). */
export function normalizarFala(pcm: Float32Array): Float32Array {
  if (pcm.length === 0) return pcm;
  let pico = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > pico) pico = a;
  }
  if (pico < 1e-6) return pcm;
  const ganho = Math.min(6, 0.85 / pico); // teto de 6x pra não explodir ruído
  if (ganho <= 1.05) return pcm;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) * ganho;
  return out;
}
