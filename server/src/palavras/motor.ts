import type { Fala } from '../recall/transcript.js';
import { TOPICOS, type TopicoDominio } from './topicos.js';

/**
 * Motor de palavras-chave SEM IA — só código.
 *
 * Lê as falas da transcrição e conta menções aos tópicos do dicionário
 * (topicos.ts). O produto disso é um comentário interno curto na conversa do
 * chatPro: a transcrição completa fica no painel, e aqui saem só os interesses
 * detectados — decisão de LGPD e de sinal/ruído, não limitação técnica.
 *
 * Por que contar cliente e atendente SEPARADO: o atendente cita "plano" e
 * "API" o tempo todo porque está vendendo — isso é roteiro, não sinal. O que
 * indica interesse é o CLIENTE puxar o assunto. Mesmo assim o total não é
 * descartado: um tópico que só o atendente tocou ainda aparece, só que sem o
 * destaque de interesse do cliente.
 */

/** Um tópico detectado na transcrição, já pronto pro comentário/painel. */
export interface TopicoDetectado {
  chave: string;
  rotulo: string;
  /** Total de menções (cliente + atendente). */
  mencoes: number;
  /** Menções em falas que NÃO são do host — o sinal que importa. */
  mencoesCliente: number;
  /** Menções em falas do host (atendente). */
  mencoesAtendente: number;
  /** Trecho literal (até 90 chars) da 1ª fala do cliente que casou; fallback: atendente. */
  exemplo: string;
}

/** Teto do trecho de exemplo — cabe num comentário sem virar transcrição. */
const LIMITE_EXEMPLO = 90;

/**
 * Normaliza pra comparação (NFD, sem diacríticos, minúsculas) e devolve um
 * MAPA de posição normalizada → posição no texto original. O mapa existe
 * porque o exemplo do comentário precisa ser LITERAL: a busca acontece no
 * texto normalizado, mas o trecho exibido sai do original, com acentos.
 */
function normalizarComMapa(texto: string): { norm: string; mapa: number[] } {
  let norm = '';
  const mapa: number[] = [];
  let indice = 0;
  for (const c of texto) {
    for (const parte of c.normalize('NFD')) {
      // Descarta só as marcas combinantes (os acentos soltos do NFD).
      if (/[\u0300-\u036f]/.test(parte)) continue;
      for (const b of parte.toLowerCase()) {
        norm += b;
        mapa.push(indice);
      }
    }
    indice += c.length;
  }
  return { norm, mapa };
}

/** Normalização simples, sem mapa — pra quem só precisa comparar. */
export function normalizarTexto(texto: string): string {
  return normalizarComMapa(texto).norm;
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compila uma expressão do dicionário em regex:
 * - fronteira de palavra nas pontas ("api" não casa em "rapida" nem "rapida" o contém);
 * - espaços internos viram \s+ (transcrição vem com espaçamento irregular).
 * A fronteira é feita com lookaround em [a-z0-9] em vez de \b porque o texto
 * já foi normalizado pra ASCII minúsculo — assim "api." e "api," casam normal.
 */
function compilarExpressao(expressao: string): RegExp {
  const corpo = expressao
    .trim()
    .split(/\s+/)
    .map(escaparRegex)
    .join('\\s+');
  return new RegExp(`(?<![a-z0-9])${corpo}(?![a-z0-9])`, 'g');
}

interface TopicoCompilado {
  topico: TopicoDominio;
  padroes: RegExp[];
}

/** Casa os padrões de um tópico numa fala normalizada. */
function casarNaFala(
  norm: string,
  padroes: RegExp[]
): { mencoes: number; primeiroIndice: number; primeiroFim: number } {
  let mencoes = 0;
  let primeiroIndice = -1;
  let primeiroFim = -1;
  for (const padrao of padroes) {
    padrao.lastIndex = 0; // regex 'g' guarda estado entre execuções
    for (const m of norm.matchAll(padrao)) {
      mencoes += 1;
      const inicio = m.index ?? 0;
      if (primeiroIndice === -1 || inicio < primeiroIndice) {
        primeiroIndice = inicio;
        primeiroFim = inicio + m[0].length;
      }
    }
  }
  return { mencoes, primeiroIndice, primeiroFim };
}

/**
 * Recorta um trecho literal de até LIMITE_EXEMPLO chars que CONTENHA a menção.
 * Numa fala gigante, cortar sempre do início esconderia a palavra que casou —
 * então a janela abre um pouco antes da menção e corta em espaço, com "…" nas
 * pontas cortadas.
 */
function extrairTrecho(original: string, inicioOrig: number): string {
  const texto = original.trim();
  if (texto.length <= LIMITE_EXEMPLO) return texto;

  // 88 de conteúdo + até 2 chars de "…" = teto de 90.
  const tamanhoJanela = LIMITE_EXEMPLO - 2;
  let inicio = Math.max(0, inicioOrig - 25);
  if (inicio + tamanhoJanela > original.length) {
    inicio = Math.max(0, original.length - tamanhoJanela);
  }
  // Corta no começo de uma palavra pra não abrir no meio de termo.
  if (inicio > 0) {
    const espaco = original.indexOf(' ', inicio);
    if (espaco !== -1 && espaco < inicioOrig) inicio = espaco + 1;
  }
  let fim = inicio + tamanhoJanela;
  // Corta no fim de uma palavra também.
  if (fim < original.length) {
    const espaco = original.lastIndexOf(' ', fim);
    if (espaco > inicioOrig) fim = espaco;
  }
  const prefixo = inicio > 0 ? '…' : '';
  const sufixo = fim < original.length ? '…' : '';
  return prefixo + original.slice(inicio, fim).trim() + sufixo;
}

/**
 * Detecta os tópicos do dicionário nas falas da transcrição.
 *
 * Falas sem `isHost` contam como cliente: participante que o Recall não
 * marcou como host é, na prática, gente de fora — melhor superestimar
 * interesse do que perdê-lo.
 *
 * Devolve só tópicos com pelo menos 1 menção, ordenados por menções do
 * cliente (desc) e depois pelo total.
 */
export function detectarTopicos(
  falas: Fala[],
  topicos: TopicoDominio[] = TOPICOS
): TopicoDetectado[] {
  const compilados: TopicoCompilado[] = topicos.map((topico) => ({
    topico,
    padroes: topico.expressoes.map(compilarExpressao),
  }));

  interface Acumulado {
    mencoesCliente: number;
    mencoesAtendente: number;
    exemploCliente: string | null;
    exemploAtendente: string | null;
  }
  const porChave = new Map<string, Acumulado>();

  for (const fala of falas) {
    if (!fala.text.trim()) continue;
    const { norm, mapa } = normalizarComMapa(fala.text);
    const doAtendente = fala.isHost === true;

    for (const { topico, padroes } of compilados) {
      const { mencoes, primeiroIndice } = casarNaFala(norm, padroes);
      if (mencoes === 0) continue;

      let acc = porChave.get(topico.chave);
      if (!acc) {
        acc = { mencoesCliente: 0, mencoesAtendente: 0, exemploCliente: null, exemploAtendente: null };
        porChave.set(topico.chave, acc);
      }

      const inicioOrig = mapa[primeiroIndice] ?? 0;
      if (doAtendente) {
        acc.mencoesAtendente += mencoes;
        if (acc.exemploAtendente === null) acc.exemploAtendente = extrairTrecho(fala.text, inicioOrig);
      } else {
        acc.mencoesCliente += mencoes;
        if (acc.exemploCliente === null) acc.exemploCliente = extrairTrecho(fala.text, inicioOrig);
      }
    }
  }

  const resultados: TopicoDetectado[] = [];
  for (const { topico } of compilados) {
    const acc = porChave.get(topico.chave);
    if (!acc) continue;
    resultados.push({
      chave: topico.chave,
      rotulo: topico.rotulo,
      mencoes: acc.mencoesCliente + acc.mencoesAtendente,
      mencoesCliente: acc.mencoesCliente,
      mencoesAtendente: acc.mencoesAtendente,
      // Interesse é do cliente: o exemplo dele tem prioridade sempre.
      exemplo: acc.exemploCliente ?? acc.exemploAtendente ?? '',
    });
  }

  resultados.sort(
    (a, b) => b.mencoesCliente - a.mencoesCliente || b.mencoes - a.mencoes
  );
  return resultados;
}

/** Metadados opcionais do comentário (hoje só o tipo da reunião). */
export interface MetaComentario {
  /** Rótulo do tipo de reunião ("apresentação", "migração"…), se quiser exibir. */
  tipo?: string | null;
}

/** Teto de tópicos na linha de resumo — comentário é vitrine, não relatório. */
const MAX_TOPICOS_COMENTARIO = 6;
/** Teto de trechos citados — mais que isso já parece transcrição. */
const MAX_EXEMPLOS_COMENTARIO = 3;

/**
 * Formata o comentário interno pro chatPro. Devolve `null` quando não há
 * tópico nenhum — quem chama não posta nada, porque comentário vazio só
 * gera ruído na conversa.
 *
 * O número exibido é o de menções do CLIENTE quando existe; tópico que só o
 * atendente citou aparece marcado como tal, pra ninguém ler roteiro de venda
 * como interesse do cliente.
 */
export function formatarComentarioPalavras(
  resultados: TopicoDetectado[],
  meta: MetaComentario = {}
): string | null {
  if (resultados.length === 0) return null;

  const top = resultados.slice(0, MAX_TOPICOS_COMENTARIO);
  const itens = top
    .map((r) =>
      r.mencoesCliente > 0
        ? `${r.rotulo} (${r.mencoesCliente}x)`
        : `${r.rotulo} (${r.mencoes}x, só o atendente)`
    )
    .join(' · ');

  const tipo = meta.tipo?.trim();
  const titulo = tipo
    ? `🔎 *Interesses identificados na reunião* — ${tipo}`
    : '🔎 *Interesses identificados na reunião*';

  const exemplos: string[] = [];
  const vistos = new Set<string>();
  for (const r of top) {
    if (exemplos.length >= MAX_EXEMPLOS_COMENTARIO) break;
    if (!r.exemplo || vistos.has(r.exemplo)) continue;
    vistos.add(r.exemplo);
    exemplos.push(`"${r.exemplo}"`);
  }

  const corpo = `${titulo}\n${itens}`;
  return exemplos.length > 0 ? `${corpo}\n\n${exemplos.join('\n')}` : corpo;
}
