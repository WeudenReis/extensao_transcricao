import { z } from 'zod';

/**
 * Contrato do JSON que pedimos ao modelo e a limpeza aplicada em cima dele.
 *
 * Fica separado do cliente HTTP porque a validação é a fronteira de confiança:
 * o que vier fora deste formato não vira resumo, vira `null` — e o comentário
 * no chatPro cai no texto de fallback em vez de sair torto na conversa do
 * cliente.
 */

export interface ResumoReuniao {
  /** O que ficou decidido. */
  combinado: string[];
  /** Riscos, objeções, pontos sensíveis. */
  atencao: string[];
  /** 1-2 frases, quando couber. */
  resumoLivre?: string;
}

/**
 * Tetos de tamanho. Não são estética: o resumo vira comentário no chatPro, e
 * um modelo prolixo devolvendo 40 bullets transformaria a conversa do cliente
 * num paredão. Cortar aqui é mais barato do que confiar no prompt.
 */
const MAX_ITENS = 8;
const MAX_CARACTERES_ITEM = 300;
const MAX_CARACTERES_LIVRE = 600;

export const resumoSchema = z.object({
  combinado: z.array(z.string()),
  atencao: z.array(z.string()),
  resumoLivre: z.string().optional(),
});

function truncar(texto: string, limite: number): string {
  return texto.length > limite ? `${texto.slice(0, limite - 1).trimEnd()}…` : texto;
}

function limparLista(itens: string[]): string[] {
  return itens
    // O modelo às vezes devolve o marcador junto ("- fechar contrato"), e o
    // formatador já põe o dele — sem isto sairia "• - fechar contrato".
    .map((item) => item.replace(/^[-•*\s]+/, '').trim())
    .filter((item) => item !== '')
    .slice(0, MAX_ITENS)
    .map((item) => truncar(item, MAX_CARACTERES_ITEM));
}

/**
 * Valida e limpa a resposta do modelo. Devolve `null` quando o formato não
 * bate — quem chama trata isso como "não houve resumo".
 *
 * Listas vazias NÃO viram null: reunião em que nada foi decidido é um
 * resultado legítimo, diferente de falha de geração.
 */
export function normalizarResumo(bruto: unknown): ResumoReuniao | null {
  const parsed = resumoSchema.safeParse(bruto);
  if (!parsed.success) return null;

  const resumo: ResumoReuniao = {
    combinado: limparLista(parsed.data.combinado),
    atencao: limparLista(parsed.data.atencao),
  };
  const livre = (parsed.data.resumoLivre ?? '').trim();
  if (livre !== '') resumo.resumoLivre = truncar(livre, MAX_CARACTERES_LIVRE);
  return resumo;
}
