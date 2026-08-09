import { normalizarResumo, type ResumoReuniao } from './schema.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Resumo pelo **Gemini**, no free tier do Google.
 *
 * Por que está aqui: o free tier é gratuito de verdade (sem cartão) e o
 * projeto já tem conta no Google Cloud pro Calendar. Para este volume —
 * um resumo por reunião — os limites sobram.
 *
 * ⚠️ RESSALVA QUE PRECISA SER DECIDIDA, NÃO IGNORADA: nos termos do Google, o
 * conteúdo enviado pelo FREE TIER pode ser usado pra treinar os modelos deles.
 * O que sai daqui é transcrição de conversa com cliente. Antes de ligar isto
 * em produção, alguém precisa aceitar esse trade-off — ou usar o tier pago (que
 * não treina), ou ficar no resumo extrativo, que não manda nada pra lugar
 * nenhum.
 */

const log = createLogger('resumo/gemini');

export const GEMINI_MODELO_PADRAO = 'gemini-2.5-flash';
const TIMEOUT_MS = 60_000;

function urlDoModelo(modelo: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
}

export interface GerarComGeminiOptions {
  apiKey: string;
  modelo?: string | undefined;
  system: string;
  user: string;
  fetchImpl?: typeof fetch;
}

/** Devolve null em qualquer falha — nunca lança. */
export async function gerarComGemini(o: GerarComGeminiOptions): Promise<ResumoReuniao | null> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const modelo = o.modelo ?? GEMINI_MODELO_PADRAO;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetchImpl(urlDoModelo(modelo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: 'user', parts: [{ text: o.user }] }],
        generationConfig: {
          // Pedir JSON no schema evita o modelo devolver markdown em volta,
          // que era a causa mais comum de resposta inaproveitável.
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      }),
      signal: controller.signal,
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      log.warn(`Gemini respondeu HTTP ${resposta.status} — resumo desta reunião não sai. ${detalhe.slice(0, 160)}`);
      return null;
    }

    const corpo = (await resposta.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const texto = corpo.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!texto.trim()) {
      log.warn('Gemini respondeu sem texto aproveitável.');
      return null;
    }

    let bruto: unknown;
    try {
      bruto = JSON.parse(texto);
    } catch {
      log.warn('Gemini não devolveu JSON válido.');
      return null;
    }
    return normalizarResumo(bruto);
  } catch (err) {
    if (controller.signal.aborted) {
      log.warn(`Gemini não respondeu em ${Math.round(TIMEOUT_MS / 1000)} s.`);
    } else {
      log.warn(`falha ao falar com o Gemini: ${errorMessage(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
