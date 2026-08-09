import type { Fala } from '../recall/transcript.js';
import type { ResumoReuniao } from './schema.js';

/**
 * Resumo SEM IA nenhuma — só código.
 *
 * Não compete com um modelo de linguagem, e não tenta. O que ele faz é
 * garimpar as falas que carregam decisão ou risco, usando as marcas que a
 * própria língua dá ("vou mandar", "fica combinado", "até sexta", "R$ 300",
 * "não consigo"), e devolvê-las quase como foram ditas.
 *
 * Três motivos pra existir:
 *
 * 1. É o padrão quando não há chave configurada. Melhor entregar as frases que
 *    provavelmente importam do que só o cabeçalho.
 * 2. Custa zero e não sai da máquina — transcrição de reunião é conversa de
 *    cliente, e mandar isso pra fora tem peso (LGPD).
 * 3. Não inventa. Todo item é trecho literal da transcrição; se errar, erra
 *    escolhendo a frase errada, nunca criando uma que ninguém disse.
 */

/** Marcas de que a frase carrega um COMBINADO. */
const MARCAS_COMBINADO = [
  /\bvou (mandar|enviar|fazer|passar|ver|checar|confirmar|retornar|preparar)\b/i,
  /\bvamos (fazer|marcar|seguir|fechar|comecar|começar|deixar|alinhar)\b/i,
  /\b(fica|ficou|ficamos) (combinado|acertado|assim|de)\b/i,
  /\b(te|lhe) (mando|envio|passo|retorno)\b/i,
  /\bpode (deixar|contar|ser)\b/i,
  /\bat[ée] (segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|amanh[ãa]|hoje|logo)\b/i,
  /\bpr[óo]xim[ao] (semana|m[êe]s|reuni[ãa]o|passo)\b/i,
  /\bfech(ado|amos)\b/i,
  /\bcombinad[oa]\b/i,
];

/** Marcas de RISCO, objeção ou pendência. */
const MARCAS_ATENCAO = [
  /\bn[ãa]o (consigo|posso|dá|da|deu|funciona|funcionou|entendi|tenho)\b/i,
  /\b(problema|erro|falha|bug|reclama|reclamação|insatisfeit)/i,
  /\b(caro|car[íi]ssimo|preço alto|mais barato|desconto)\b/i,
  /\b(concorrente|outra empresa|outro fornecedor)\b/i,
  /\b(prazo|atras|atrasad|urgente|urg[êe]ncia)\b/i,
  /\b(cancelar|cancelamento|encerrar contrato)\b/i,
  /\b(dúvida|duvida|não ficou claro|nao ficou claro)\b/i,
  /\bpreciso pensar\b/i,
];

/** Valores e datas quase sempre importam num atendimento. */
const MARCAS_CONCRETAS = [
  /R\$\s?\d/,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b\d{1,2}h(\d{2})?\b/,
  /\b\d+\s?(dias?|semanas?|meses|horas?)\b/,
];

/** Falas curtas demais são "sim", "tá", "uhum" — ruído. */
const MIN_CARACTERES = 25;
const MAX_ITENS = 5;

function pontuar(texto: string, marcas: RegExp[]): number {
  let n = 0;
  for (const m of marcas) if (m.test(texto)) n += 1;
  for (const m of MARCAS_CONCRETAS) if (m.test(texto)) n += 1;
  return n;
}

/** Deixa a frase apresentável sem reescrevê-la. */
function limpar(texto: string): string {
  const t = texto.trim().replace(/\s+/g, ' ');
  const comMaiuscula = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(comMaiuscula) ? comMaiuscula : `${comMaiuscula}.`;
}

function escolher(falas: Fala[], marcas: RegExp[]): string[] {
  const candidatos = falas
    .filter((f) => f.text.trim().length >= MIN_CARACTERES)
    .map((f) => ({ fala: f, nota: pontuar(f.text, marcas) }))
    .filter((c) => c.nota > 0)
    // Nota desc; empate resolve pelo que veio DEPOIS na conversa — o fim é
    // onde ficam os fechamentos.
    .sort((a, b) => b.nota - a.nota || b.fala.startMs - a.fala.startMs)
    .slice(0, MAX_ITENS);

  // De volta à ordem da conversa: ler fora de ordem confunde.
  candidatos.sort((a, b) => a.fala.startMs - b.fala.startMs);

  const vistos = new Set<string>();
  const itens: string[] = [];
  for (const c of candidatos) {
    const texto = limpar(c.fala.text);
    const chave = texto.toLowerCase().slice(0, 40);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    itens.push(`${c.fala.speaker}: ${texto}`);
  }
  return itens;
}

/**
 * Monta o resumo extrativo. Devolve `null` quando não achou nada que valha —
 * aí o cabeçalho sozinho é mais honesto que uma lista de frases aleatórias.
 */
export function resumoExtrativo(falas: Fala[]): ResumoReuniao | null {
  if (falas.length === 0) return null;

  const combinado = escolher(falas, MARCAS_COMBINADO);
  const atencao = escolher(falas, MARCAS_ATENCAO);
  if (combinado.length === 0 && atencao.length === 0) return null;

  return {
    combinado,
    atencao,
    resumoLivre:
      'Trechos destacados automaticamente da transcrição, sem uso de IA — ' +
      'as frases são literais, mas a escolha pode não ser a melhor.',
  };
}
