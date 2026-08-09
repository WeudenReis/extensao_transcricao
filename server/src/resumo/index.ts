import { z } from 'zod';
import { createLogger, errorMessage } from '../log.js';
import type { Fala } from '../recall/transcript.js';
import { montarPrompt, type ParticipanteResumo } from './prompt.js';
import { normalizarResumo, type ResumoReuniao } from './schema.js';
import { resumoExtrativo } from './extrativo.js';
export { resumoExtrativo } from './extrativo.js';
import { gerarComGemini } from './gemini.js';

/**
 * Resumo da reunião por IA (API da Anthropic).
 *
 * DECISÃO CENTRAL: `gerarResumo` NUNCA lança. Sem chave, com erro de rede, com
 * HTTP 500 ou com resposta fora do formato, devolve `null`. O comentário que
 * vai pro chatPro contém SÓ o resumo (a transcrição completa fica no painel);
 * se uma falha aqui propagasse, o cliente não receberia nada — em vez disso
 * `formatarResumo` monta o cabeçalho e avisa que o resumo não saiu.
 *
 * REGRAS DE LOG (inegociáveis):
 * - a API key nunca aparece em log nem em mensagem de erro;
 * - a transcrição e o resumo nunca são logados (LGPD) — só contagens e status;
 * - do erro HTTP logamos o status, nunca o corpo (pode ecoar o que mandamos).
 */

const log = createLogger('resumo');

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const MODELO_PADRAO = 'claude-sonnet-5';
export const RESUMO_TIMEOUT_MS = 60_000;

/**
 * Teto de saída. O resumo é curto, mas o modelo pensa antes de responder e o
 * `max_tokens` cobre raciocínio + texto — apertado demais, o JSON sai cortado
 * e a validação derruba tudo pro fallback.
 */
const MAX_TOKENS = 4096;

export type { ResumoReuniao } from './schema.js';

/**
 * Quem escreve o resumo.
 *
 * - `extrativo`: só código, sem IA. Custa zero e NADA sai da máquina.
 * - `gemini`:    free tier do Google. Grátis de verdade, mas o conteúdo do
 *                 free tier pode ser usado pra treinar os modelos deles.
 * - `anthropic`: melhor resultado, pago, sem treino sobre dados de API.
 *
 * `auto` escolhe pela chave disponível, nesta ordem: anthropic → gemini →
 * extrativo. O extrativo é sempre o piso: nunca ficamos sem resumo nenhum.
 */
export const PROVEDORES_RESUMO = ['auto', 'anthropic', 'gemini', 'extrativo'] as const;
export type ProvedorResumo = (typeof PROVEDORES_RESUMO)[number];

export interface GerarResumoOptions {
  falas: Fala[];
  participantes: ParticipanteResumo[];
  duracaoSegundos: number;
  apiKey: string | undefined;
  /** Chave do Gemini (free tier). */
  geminiApiKey?: string | undefined;
  provedor?: ProvedorResumo | undefined;
  modelo?: string;
  /** Injetável nos testes — a suíte nunca toca a rede. */
  fetchImpl?: typeof fetch;
  /** Só pro teste não esperar 60 s de verdade. */
  timeoutMs?: number;
  /** Orçamento de caracteres da transcrição (ver prompt.ts). */
  orcamentoCaracteres?: number;
}

/** Envelope da resposta da API. Só o que a gente realmente usa. */
const respostaSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
  stop_reason: z.string().nullish(),
});

/**
 * Tira o JSON do texto do modelo. Ele foi instruído a devolver só o objeto,
 * mas cerca de código e uma frase de introdução acontecem — e cair no
 * fallback por causa de três crases seria desperdício.
 */
function extrairJson(texto: string): unknown {
  const limpo = texto
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(limpo);
  } catch {
    // Continua: tenta achar o objeto no meio do texto.
  }
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio >= 0 && fim > inicio) {
    try {
      return JSON.parse(limpo.slice(inicio, fim + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Gera o resumo. Devolve `null` em qualquer caminho de falha — ver o bloco de
 * decisão no topo do arquivo.
 */
/** Qual provedor usar de fato, dado o que está configurado. */
export function escolherProvedor(o: GerarResumoOptions): Exclude<ProvedorResumo, 'auto'> {
  const pedido = o.provedor ?? 'auto';
  if (pedido !== 'auto') return pedido;
  if (o.apiKey) return 'anthropic';
  if (o.geminiApiKey) return 'gemini';
  return 'extrativo';
}

export async function gerarResumo(o: GerarResumoOptions): Promise<ResumoReuniao | null> {
  if (o.falas.length === 0) {
    log.info('transcrição sem falas — nada a resumir.');
    return null;
  }

  const provedor = escolherProvedor(o);

  // Sem IA: garimpa as frases que carregam decisão e risco. Não sai da máquina.
  if (provedor === 'extrativo') {
    const r = resumoExtrativo(o.falas);
    log.info(`resumo extrativo (sem IA): ${r ? 'gerado' : 'nada relevante encontrado'}.`);
    return r;
  }


  if (provedor === 'gemini') {
    if (!o.geminiApiKey) {
      log.info('GEMINI_API_KEY vazia — sem resumo por IA.');
      return null;
    }
    const promptG = montarPrompt({
      falas: o.falas,
      participantes: o.participantes,
      duracaoSegundos: o.duracaoSegundos,
      ...(o.orcamentoCaracteres === undefined ? {} : { orcamento: o.orcamentoCaracteres }),
    });
    const r = await gerarComGemini({
      apiKey: o.geminiApiKey,
      modelo: o.modelo,
      system: promptG.system,
      user: promptG.user,
      ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    });
    return r;
  }

  if (!o.apiKey) {
    log.info('ANTHROPIC_API_KEY vazia — sem resumo por IA.');
    return null;
  }

  const modelo = o.modelo ?? MODELO_PADRAO;
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? RESUMO_TIMEOUT_MS;
  const prompt = montarPrompt({
    falas: o.falas,
    participantes: o.participantes,
    duracaoSegundos: o.duracaoSegundos,
    ...(o.orcamentoCaracteres === undefined ? {} : { orcamento: o.orcamentoCaracteres }),
  });

  log.info(
    `pedindo resumo (${modelo}): ${prompt.recorte.falasEnviadas} fala(s) enviadas, ` +
      `${prompt.recorte.falasOmitidas} omitidas, ${prompt.recorte.texto.length} caracteres`
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': o.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: MAX_TOKENS,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Só o status: o corpo do erro pode ecoar trechos do que enviamos.
      log.warn(`API da Anthropic respondeu HTTP ${response.status} — sem resumo desta vez.`);
      return null;
    }

    const bruto: unknown = await response.json();
    const envelope = respostaSchema.safeParse(bruto);
    if (!envelope.success) {
      log.warn('resposta da Anthropic em formato inesperado — sem resumo desta vez.');
      return null;
    }
    if (envelope.data.stop_reason === 'refusal') {
      log.warn('modelo recusou a solicitação — sem resumo desta vez.');
      return null;
    }

    const texto = envelope.data.content
      // Blocos de raciocínio entram no content e não são a resposta.
      .filter((bloco) => bloco.type === 'text')
      .map((bloco) => bloco.text ?? '')
      .join('\n')
      .trim();
    if (texto === '') {
      log.warn('modelo respondeu sem texto — sem resumo desta vez.');
      return null;
    }

    const resumo = normalizarResumo(extrairJson(texto));
    if (!resumo) {
      log.warn('resumo fora do formato esperado (JSON inválido) — caindo no texto de fallback.');
      return null;
    }

    log.info(
      `resumo pronto: ${resumo.combinado.length} combinado(s), ` +
        `${resumo.atencao.length} ponto(s) de atenção, ` +
        `resumo livre ${resumo.resumoLivre ? 'presente' : 'ausente'}`
    );
    return resumo;
  } catch (err) {
    if (controller.signal.aborted) {
      log.warn(`resumo abortado por timeout (${Math.round(timeoutMs / 1000)} s).`);
      return null;
    }
    // A mensagem do fetch fala de DNS/conexão e nunca carrega a API key.
    log.warn(`falha ao chamar a API da Anthropic: ${errorMessage(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Formatação do texto que vai pro chatPro ─────────────────────────────────

export interface ResumoMeta {
  duracaoSegundos: number;
  participantes: { nome: string }[];
  /** Link da reunião (Meet). */
  meetingUrl?: string | undefined;
  /** Link do painel, onde fica a transcrição completa. */
  painelUrl?: string | undefined;
}

/**
 * Duplicado de propósito: a versão do chatpro/client.ts não é exportada e
 * aquele arquivo é editado por outra pessoa nesta feature.
 */
function duracaoLegivel(segundos: number): string {
  if (segundos < 60) return `${Math.max(0, Math.round(segundos))}s`;
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto === 0 ? `${h}h` : `${h}h${String(resto).padStart(2, '0')}`;
}

function montarCabecalho(meta: ResumoMeta): string[] {
  const linhas = ['📝 *Resumo da reunião*'];
  if (meta.duracaoSegundos > 0) {
    linhas[0] += ` — ${duracaoLegivel(meta.duracaoSegundos)}`;
  }
  const nomes = meta.participantes.map((p) => p.nome.trim()).filter((n) => n !== '');
  if (nomes.length > 0) linhas.push(nomes.join(' · '));
  if (meta.meetingUrl) linhas.push(meta.meetingUrl);
  return linhas;
}

function bloco(titulo: string, itens: string[]): string {
  return [`*${titulo}*`, ...itens.map((item) => `• ${item}`)].join('\n');
}

/**
 * Monta o texto do comentário. PRECISA entregar algo útil mesmo com `null`:
 * nesse caso sai o cabeçalho e o aviso de que o resumo não saiu, com a
 * transcrição completa apontada pro painel.
 */
export function formatarResumo(resumo: ResumoReuniao | null, meta: ResumoMeta): string {
  const partes: string[] = [montarCabecalho(meta).join('\n')];

  if (!resumo) {
    partes.push('_O resumo automático não saiu desta vez. A transcrição completa está no painel._');
    if (meta.painelUrl) partes.push(meta.painelUrl);
    return partes.join('\n\n');
  }

  if (resumo.resumoLivre) partes.push(resumo.resumoLivre);
  if (resumo.combinado.length > 0) partes.push(bloco('Combinado', resumo.combinado));
  if (resumo.atencao.length > 0) partes.push(bloco('Atenção', resumo.atencao));

  if (!resumo.resumoLivre && resumo.combinado.length === 0 && resumo.atencao.length === 0) {
    partes.push('_Nada ficou definido nesta conversa._');
  }

  const rodape = 'Transcrição completa no painel.';
  partes.push(meta.painelUrl ? `_${rodape}_\n${meta.painelUrl}` : `_${rodape}_`);
  return partes.join('\n\n');
}
