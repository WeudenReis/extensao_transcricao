import { marcarTempo } from '../chatpro/client.js';
import type { Fala } from '../recall/transcript.js';

/**
 * Montagem do prompt e o recorte da transcrição que cabe nele.
 *
 * Uma reunião de uma hora passa fácil de 100 mil caracteres. Em vez de mandar
 * tudo (caro, lento e às vezes acima do limite), cortamos por ORÇAMENTO — e o
 * corte pega INÍCIO e FIM, nunca só o começo: o fechamento é justamente onde
 * ficam os combinados, que são a razão de existir deste módulo.
 */

/** Teto de caracteres de transcrição enviados ao modelo. */
export const ORCAMENTO_CARACTERES = 60_000;

/**
 * Quanto do orçamento fica reservado pro fim da conversa. Mais da metade de
 * propósito: o desfecho vale mais que a abertura pra extrair decisões.
 */
const FATIA_DO_FIM = 0.6;

const MARCADOR_CORTE = '[… trecho do meio omitido …]';

export interface ParticipanteResumo {
  nome: string;
  isHost: boolean;
}

export interface RecorteTranscricao {
  /** Linhas já formatadas, prontas pro prompt. */
  texto: string;
  falasEnviadas: number;
  falasOmitidas: number;
}

function linhaDaFala(fala: Fala): string {
  return `[${marcarTempo(fala.startMs)}] ${fala.speaker}: ${fala.text}`;
}

/** Custo de uma linha no orçamento: ela mais a quebra que a separa da próxima. */
function custo(linha: string): number {
  return linha.length + 1;
}

/**
 * Corta a transcrição em início + fim até caber no orçamento.
 * `falasOmitidas` é o que ficou de fora no meio — vai pro log (contagem, nunca
 * conteúdo) e pro próprio prompt, pra o modelo saber que não viu tudo.
 */
export function recortarTranscricao(
  falas: Fala[],
  orcamento: number = ORCAMENTO_CARACTERES
): RecorteTranscricao {
  const linhas = falas.map(linhaDaFala);
  const total = linhas.reduce((soma, linha) => soma + custo(linha), 0);
  if (total <= orcamento) {
    return { texto: linhas.join('\n'), falasEnviadas: linhas.length, falasOmitidas: 0 };
  }

  const orcamentoFim = Math.floor(orcamento * FATIA_DO_FIM);
  let usado = 0;

  // Fim primeiro: é a parte que não pode faltar.
  const fim: string[] = [];
  let ultimoDoMeio = linhas.length - 1;
  while (ultimoDoMeio >= 0) {
    const linha = linhas[ultimoDoMeio] as string;
    if (usado + custo(linha) > orcamentoFim) break;
    fim.unshift(linha);
    usado += custo(linha);
    ultimoDoMeio -= 1;
  }

  // Início com o que sobrou do orçamento inteiro (inclusive a folga que o fim
  // não usou, quando as últimas falas são curtas).
  const inicio: string[] = [];
  let primeiroDoMeio = 0;
  while (primeiroDoMeio <= ultimoDoMeio) {
    const linha = linhas[primeiroDoMeio] as string;
    if (usado + custo(linha) > orcamento) break;
    inicio.push(linha);
    usado += custo(linha);
    primeiroDoMeio += 1;
  }

  // Uma única fala maior que o orçamento inteiro deixaria os dois lados vazios
  // e mandaria só o marcador — aí é melhor mandar o fim dela truncado.
  if (inicio.length === 0 && fim.length === 0) {
    const ultima = linhas[linhas.length - 1] ?? '';
    return {
      texto: `${MARCADOR_CORTE}\n${ultima.slice(-orcamento)}`,
      falasEnviadas: 1,
      falasOmitidas: Math.max(0, linhas.length - 1),
    };
  }

  const omitidas = Math.max(0, ultimoDoMeio - primeiroDoMeio + 1);
  const partes = [...inicio, MARCADOR_CORTE, ...fim];
  return {
    texto: partes.join('\n'),
    falasEnviadas: inicio.length + fim.length,
    falasOmitidas: omitidas,
  };
}

export const SYSTEM_PROMPT = [
  'Você lê a transcrição de uma reunião de atendimento/venda e devolve um resumo curto para o atendente.',
  '',
  'Responda SOMENTE com um objeto JSON válido, sem markdown, sem cercas de código e sem nenhum texto antes ou depois. Formato exato:',
  '{"combinado": ["..."], "atencao": ["..."], "resumoLivre": "..."}',
  '',
  '- combinado: o que ficou decidido — próximos passos, prazos, valores, responsáveis. Uma frase curta por item.',
  '- atencao: riscos, objeções, dúvidas não resolvidas e pontos sensíveis. Uma frase curta por item.',
  '- resumoLivre: 1 ou 2 frases sobre o todo. Omita o campo se não acrescentar nada.',
  '',
  'Regras:',
  '- Escreva em português do Brasil, direto, sem jargão e sem enfeite.',
  '- Use só o que está na transcrição. Não deduza, não complete e não invente nomes, números ou prazos.',
  '- Nada foi decidido? Devolva "combinado": []. Sem riscos? Devolva "atencao": [].',
  '- No máximo 8 itens por lista, cada um com no máximo 300 caracteres.',
].join('\n');

export interface DadosDoPrompt {
  falas: Fala[];
  participantes: ParticipanteResumo[];
  duracaoSegundos: number;
  orcamento?: number;
}

export interface PromptMontado {
  system: string;
  user: string;
  recorte: RecorteTranscricao;
}

export function montarPrompt(dados: DadosDoPrompt): PromptMontado {
  const recorte = recortarTranscricao(dados.falas, dados.orcamento ?? ORCAMENTO_CARACTERES);

  const pessoas =
    dados.participantes.length > 0
      ? dados.participantes
          .map((p) => (p.isHost ? `${p.nome} (anfitrião)` : p.nome))
          .join(', ')
      : 'não identificados';

  const cabecalho = [
    `Duração: ${Math.max(0, Math.round(dados.duracaoSegundos / 60))} min.`,
    `Participantes: ${pessoas}.`,
  ];
  if (recorte.falasOmitidas > 0) {
    cabecalho.push(
      `Atenção: ${recorte.falasOmitidas} fala(s) do meio da conversa foram omitidas por tamanho. ` +
        'Você está vendo o começo e o fim.'
    );
  }

  const user = [
    ...cabecalho,
    '',
    'Transcrição:',
    '<transcricao>',
    recorte.texto,
    '</transcricao>',
    '',
    'Devolva agora apenas o JSON.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user, recorte };
}
