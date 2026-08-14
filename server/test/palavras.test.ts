import { describe, it, expect } from 'vitest';
import {
  detectarTopicos,
  formatarComentarioPalavras,
  normalizarTexto,
  type TopicoDetectado,
} from '../src/palavras/motor.js';
import { TOPICOS } from '../src/palavras/topicos.js';
import type { Fala } from '../src/recall/transcript.js';

/**
 * Motor de palavras-chave — 100% código, zero rede, zero IA.
 *
 * Os pontos críticos aqui são os que já morderam em produção em projetos
 * parecidos: acento (transcrição vem com e sem), fronteira de palavra ("api"
 * dentro de "rapida"), e a separação cliente × atendente — o comentário
 * existe pra mostrar interesse do CLIENTE, não o roteiro do vendedor.
 */

/** Fábrica de fala: só o que o motor lê, com defaults razoáveis. */
function fala(text: string, isHost = false, startMs = 0): Fala {
  return {
    speaker: isHost ? 'Atendente chatPro' : 'Cliente',
    text,
    startMs,
    endMs: startMs + 5000,
    isHost,
  };
}

function porChave(resultados: TopicoDetectado[], chave: string): TopicoDetectado | undefined {
  return resultados.find((r) => r.chave === chave);
}

describe('dicionário de tópicos', () => {
  it('tem chave, rótulo e ao menos uma expressão em cada tópico', () => {
    expect(TOPICOS.length).toBeGreaterThan(0);
    for (const t of TOPICOS) {
      expect(t.chave).toBeTruthy();
      expect(t.rotulo).toBeTruthy();
      expect(t.expressoes.length).toBeGreaterThan(0);
    }
  });

  it('expressões já estão normalizadas (sem acento, minúsculas) — contrato com o motor', () => {
    for (const t of TOPICOS) {
      for (const e of t.expressoes) {
        expect(e, `expressão "${e}" do tópico "${t.chave}"`).toBe(normalizarTexto(e));
      }
    }
  });
});

describe('detectarTopicos — acentos e caixa', () => {
  it('casa "distribuição" acentuada com a expressão sem acento do dicionário', () => {
    const resultados = detectarTopicos([
      fala('Como funciona a Distribuição automática de vocês?'),
    ]);
    const d = porChave(resultados, 'distribuicao');
    expect(d).toBeDefined();
    expect(d?.mencoesCliente).toBeGreaterThanOrEqual(1);
  });

  it('casa também a grafia sem acento ("migracao") e maiúsculas', () => {
    const resultados = detectarTopicos([fala('Quero saber da MIGRACAO dos contatos')]);
    expect(porChave(resultados, 'migracao')?.mencoes).toBe(1);
  });
});

describe('detectarTopicos — fronteira de palavra', () => {
  it('não casa "api" dentro de "rapida"', () => {
    const resultados = detectarTopicos([fala('a resposta de vocês é bem rapida e direta')]);
    expect(porChave(resultados, 'integracao')).toBeUndefined();
  });

  it('casa "api" como palavra isolada, inclusive colada em pontuação', () => {
    const resultados = detectarTopicos([fala('vocês têm API? preciso ligar no meu CRM.')]);
    const i = porChave(resultados, 'integracao');
    // "api" + "crm" = 2 menções do mesmo tópico.
    expect(i?.mencoesCliente).toBe(2);
  });
});

describe('detectarTopicos — expressão multi-palavra', () => {
  it('casa "api oficial" e tolera espaços múltiplos entre as palavras', () => {
    const resultados = detectarTopicos([fala('isso funciona na api   oficial do WhatsApp?')]);
    expect(porChave(resultados, 'oficial')?.mencoes).toBe(1);
  });

  it('"api oficial" conta pros DOIS tópicos: oficial (frase) e integracao (palavra "api")', () => {
    const resultados = detectarTopicos([fala('quero usar a api oficial')]);
    expect(porChave(resultados, 'oficial')?.mencoes).toBe(1);
    expect(porChave(resultados, 'integracao')?.mencoes).toBe(1);
  });
});

describe('detectarTopicos — cliente × atendente', () => {
  it('conta menções do cliente e do atendente separado, e soma no total', () => {
    const resultados = detectarTopicos([
      fala('quanto custa o plano de vocês?', false, 0),
      fala('o plano básico tem desconto no anual', true, 10_000),
    ]);
    const p = porChave(resultados, 'preco');
    // Cliente: "quanto custa" + "plano" = 2. Atendente: "plano" + "desconto" = 2.
    expect(p?.mencoesCliente).toBe(2);
    expect(p?.mencoesAtendente).toBe(2);
    expect(p?.mencoes).toBe(4);
  });

  it('fala sem isHost conta como cliente — participante não marcado é gente de fora', () => {
    const semFlag: Fala = { speaker: 'Convidado', text: 'e o chatbot?', startMs: 0, endMs: 1000 };
    const resultados = detectarTopicos([semFlag]);
    expect(porChave(resultados, 'ia')?.mencoesCliente).toBe(1);
  });

  it('ordena por menções do cliente, não pelo total', () => {
    const resultados = detectarTopicos([
      // Cliente fala 2x de migração e 1x de preço.
      fala('quero migrar, a migração é tranquila?', false, 0),
      fala('e o valor?', false, 5000),
      // Atendente martela preço 3x — total de preço (4) supera migração (2),
      // mas interesse do cliente manda na ordem.
      fala('o preço é justo, o valor cabe em qualquer mensalidade', true, 10_000),
    ]);
    expect(resultados[0]?.chave).toBe('migracao');
    expect(resultados[1]?.chave).toBe('preco');
  });
});

describe('detectarTopicos — exemplo literal', () => {
  it('o exemplo é o trecho literal (com acento) da 1ª fala do cliente que casou', () => {
    const texto = 'queria entender como funciona o chatbot de vocês, com automação';
    const resultados = detectarTopicos([
      fala('nosso agente resolve isso', true, 0), // atendente casa antes...
      fala(texto, false, 5000), // ...mas o exemplo tem que ser do cliente
    ]);
    expect(porChave(resultados, 'ia')?.exemplo).toBe(texto);
  });

  it('sem fala do cliente, cai pro trecho do atendente', () => {
    const resultados = detectarTopicos([
      fala('te mostro o dashboard com as métricas', true),
      fala('legal, obrigado', false),
    ]);
    const r = porChave(resultados, 'relatorios');
    expect(r?.mencoesCliente).toBe(0);
    expect(r?.exemplo).toBe('te mostro o dashboard com as métricas');
  });

  it('numa fala gigante o trecho fica em até 90 chars e ainda contém a menção', () => {
    const gigante =
      'a conversa segue por muito tempo sem tocar em nada demais '.repeat(20) +
      'mas então surge a pergunta sobre a api oficial do whatsapp ' +
      'e depois a conversa continua se alongando por bastante tempo ainda '.repeat(10);
    const resultados = detectarTopicos([fala(gigante)]);
    const exemplo = porChave(resultados, 'oficial')?.exemplo ?? '';
    expect(exemplo.length).toBeLessThanOrEqual(90);
    expect(normalizarTexto(exemplo)).toContain('api oficial');
  });
});

describe('detectarTopicos — vazio e ruído', () => {
  it('lista vazia de falas devolve lista vazia', () => {
    expect(detectarTopicos([])).toEqual([]);
  });

  it('falas sem nenhum tópico devolvem lista vazia (sem tópico zerado)', () => {
    const resultados = detectarTopicos([fala('bom dia, tudo bem por aí?')]);
    expect(resultados).toEqual([]);
  });

  it('fala em branco não conta nem quebra', () => {
    expect(detectarTopicos([fala('   ')])).toEqual([]);
  });
});

describe('formatarComentarioPalavras', () => {
  function resultado(parcial: Partial<TopicoDetectado> & { chave: string }): TopicoDetectado {
    return {
      rotulo: parcial.chave,
      mencoes: 1,
      mencoesCliente: 1,
      mencoesAtendente: 0,
      exemplo: `exemplo de ${parcial.chave}`,
      ...parcial,
    };
  }

  it('sem tópico nenhum devolve null — quem chama não posta nada', () => {
    expect(formatarComentarioPalavras([])).toBeNull();
  });

  it('monta título, contagens do cliente e exemplo entre aspas', () => {
    const falas = [
      fala('queria entender como funciona o chatbot de vocês', false, 0),
      fala('e quanto custa?', false, 5000),
      fala('meu cachorro latiu a reunião inteira, desculpa aí', false, 10_000),
    ];
    const comentario = formatarComentarioPalavras(detectarTopicos(falas));
    expect(comentario).toContain('*Interesses identificados na reunião*');
    expect(comentario).toContain('IA (1x)');
    expect(comentario).toContain('Preço (1x)');
    expect(comentario).toContain('"queria entender como funciona o chatbot de vocês"');
    // Comentário NUNCA carrega a transcrição — fala sem tópico fica de fora.
    expect(comentario).not.toContain('cachorro');
  });

  it('tópico que só o atendente citou vem marcado, pra não parecer interesse do cliente', () => {
    const comentario = formatarComentarioPalavras([
      resultado({ chave: 'preco', rotulo: 'Preço', mencoes: 2, mencoesCliente: 0, mencoesAtendente: 2 }),
    ]);
    expect(comentario).toContain('Preço (2x, só o atendente)');
  });

  it('limita a 3 exemplos mesmo com mais tópicos detectados', () => {
    const muitos = ['ia', 'preco', 'oficial', 'migracao', 'relatorios'].map((chave) =>
      resultado({ chave })
    );
    const comentario = formatarComentarioPalavras(muitos) ?? '';
    const aspas = comentario.match(/"exemplo de /g) ?? [];
    expect(aspas.length).toBe(3);
  });

  it('inclui o tipo da reunião no título quando informado', () => {
    const comentario = formatarComentarioPalavras([resultado({ chave: 'ia', rotulo: 'IA' })], {
      tipo: 'apresentação',
    });
    expect(comentario).toContain('— apresentação');
  });
});
