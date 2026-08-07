import { createLogger } from '../log.js';
import type { RecallTranscript, RecallWord, RecallParticipant } from './types.js';

/**
 * Normaliza o transcript do Recall.ai para o formato que o painel e o chatPro
 * consomem.
 *
 * O Recall entrega palavra a palavra, já AGRUPADAS POR PARTICIPANTE — ou seja,
 * a diarização vem pronta e correta. Não há aqui nenhuma heurística de "quem
 * falou" nem risco de texto duplicado (os dois problemas que a leitura da
 * legenda do Meet nos deu). O trabalho é só juntar palavras em falas legíveis.
 *
 * Regra de quebra: começa uma nova fala quando há PAUSA longa entre palavras ou
 * quando a anterior terminou com pontuação final — o mesmo critério que uma
 * pessoa usaria pra separar frases.
 */

const log = createLogger('recall/transcript');

/** Pausa a partir da qual consideramos que começou outra fala. */
const PAUSA_NOVA_FALA_S = 1.5;
/** Teto de tamanho pra uma fala não virar um parágrafo interminável. */
const MAX_CARACTERES_FALA = 320;

// Os tipos do formato do Recall vivem em types.js (fonte única).
export type RecallTranscriptEntry = RecallTranscript;

/** Fala já pronta para exibição/entrega. */
export interface Fala {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  isHost?: boolean;
}

export interface TranscriptNormalizado {
  falas: Fala[];
  participantes: { nome: string; isHost: boolean; email: string | null }[];
  duracaoSegundos: number;
}

function relativo(ts: RecallWord['start_timestamp']): number | null {
  const v = ts?.relative;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nomeDoParticipante(p: RecallParticipant | null | undefined, indice: number): string {
  const nome = (p?.name ?? '').trim();
  if (nome) return nome;
  // Sem nome (bot anônimo, convidado): rótulo estável em vez de "null".
  return `Participante ${p?.id ?? indice + 1}`;
}

/** Junta as palavras de um participante em falas legíveis. */
function falasDoParticipante(entrada: RecallTranscriptEntry, indice: number): Fala[] {
  const palavras = (entrada.words ?? []).filter((w) => (w?.text ?? '').trim() !== '');
  if (palavras.length === 0) return [];

  const speaker = nomeDoParticipante(entrada.participant, indice);
  const isHost = entrada.participant?.is_host === true;
  const falas: Fala[] = [];

  let buffer: string[] = [];
  let inicio: number | null = null;
  let fim: number | null = null;
  let anteriorFim: number | null = null;

  const fechar = (): void => {
    if (buffer.length === 0) return;
    const texto = buffer.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    if (texto) {
      falas.push({
        speaker,
        text: texto,
        startMs: Math.round((inicio ?? 0) * 1000),
        endMs: Math.round((fim ?? inicio ?? 0) * 1000),
        isHost,
      });
    }
    buffer = [];
    inicio = null;
    fim = null;
  };

  for (const palavra of palavras) {
    const ini = relativo(palavra.start_timestamp);
    const f = relativo(palavra.end_timestamp);
    const texto = palavra.text.trim();

    const houvePausa =
      anteriorFim !== null && ini !== null && ini - anteriorFim >= PAUSA_NOVA_FALA_S;
    const anteriorTerminouFrase = /[.!?…]$/.test(buffer[buffer.length - 1] ?? '');
    const ficouLonga = buffer.join(' ').length >= MAX_CARACTERES_FALA;

    if (buffer.length > 0 && (houvePausa || anteriorTerminouFrase || ficouLonga)) {
      fechar();
    }

    if (buffer.length === 0) inicio = ini ?? anteriorFim ?? 0;
    buffer.push(texto);
    if (f !== null) fim = f;
    if (f !== null) anteriorFim = f;
    else if (ini !== null) anteriorFim = ini;
  }
  fechar();
  return falas;
}

/** Converte o transcript cru do Recall na nossa estrutura, ordenado no tempo. */
export function normalizarTranscript(
  bruto: RecallTranscriptEntry[] | null | undefined
): TranscriptNormalizado {
  const entradas = Array.isArray(bruto) ? bruto : [];
  const falas: Fala[] = [];
  const participantes: TranscriptNormalizado['participantes'] = [];
  const vistos = new Set<string>();

  entradas.forEach((entrada, i) => {
    const nome = nomeDoParticipante(entrada.participant, i);
    if (!vistos.has(nome)) {
      vistos.add(nome);
      participantes.push({
        nome,
        isHost: entrada.participant?.is_host === true,
        email: entrada.participant?.email ?? null,
      });
    }
    falas.push(...falasDoParticipante(entrada, i));
  });

  // Ordena pela linha do tempo real da reunião (as entradas vêm por pessoa).
  falas.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const duracaoSegundos = falas.length
    ? Math.round(Math.max(...falas.map((f) => f.endMs)) / 1000)
    : 0;

  log.info(
    `transcript normalizado: ${falas.length} falas, ` +
      `${participantes.length} participante(s), ${duracaoSegundos}s`
  );
  return { falas, participantes, duracaoSegundos };
}
