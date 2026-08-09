import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Db } from '../src/db.js';

/** Busca por texto dentro das transcrições (índice FTS5 sobre `meetings`). */

const T0 = '2026-08-06T12:00:00.000Z';

interface FalaDeTeste {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

function fala(speaker: string, text: string, i: number): FalaDeTeste {
  return { speaker, text, startMs: i * 1000, endMs: i * 1000 + 900 };
}

describe('busca nas transcrições', () => {
  let db: Db;

  beforeEach(() => {
    db = new Db(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  function criarReuniao(id: string, criadaEm = T0): void {
    db.createMeeting({
      id,
      botId: `bot-${id}`,
      sessionId: `sessao-${id}`,
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      meetingCode: `codigo-${id}`,
      botName: null,
      createdAt: criadaEm,
    });
  }

  function transcrever(id: string, textos: string[]): void {
    db.setMeetingTranscript({
      id,
      transcriptJson: JSON.stringify({
        falas: textos.map((t, i) => fala('Maria', t, i)),
        participantes: [{ nome: 'Maria', isHost: true, email: null }],
      }),
      durationSeconds: textos.length,
    });
  }

  it('indexa ao salvar a transcrição e acha palavra do meio da conversa', () => {
    criarReuniao('r1');
    transcrever('r1', [
      'boa tarde, obrigado por entrar',
      'o problema é o prazo de entrega do pedido',
      'combinado, mando por escrito depois',
    ]);

    const achados = db.buscarNasTranscricoes('prazo', 10);
    expect(achados).toHaveLength(1);
    expect(achados[0]?.meetingId).toBe('r1');
    expect(achados[0]?.sessionId).toBe('sessao-r1');
    expect(achados[0]?.meetingCode).toBe('codigo-r1');
    expect(achados[0]?.quando).toBe(T0);
    expect(achados[0]?.trecho).toContain('[prazo]');
    expect(achados[0]?.trecho).toContain('entrega');
  });

  it('reunião sem transcrição não aparece, e termo ausente devolve vazio', () => {
    criarReuniao('r1');
    transcrever('r1', ['falamos só de logística']);
    criarReuniao('r2');

    expect(db.buscarNasTranscricoes('logística', 10).map((a) => a.meetingId)).toEqual(['r1']);
    expect(db.buscarNasTranscricoes('futebol', 10)).toEqual([]);
  });

  it('acento não atrapalha: acha nos dois sentidos', () => {
    criarReuniao('r1');
    transcrever('r1', ['preciso revisar o orçamento antes da negociação']);

    expect(db.buscarNasTranscricoes('orçamento', 10)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('orcamento', 10)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('negociacao', 10)).toHaveLength(1);
    // E o trecho devolve o texto ORIGINAL, com acento — o dobramento é só do índice.
    expect(db.buscarNasTranscricoes('orcamento', 10)[0]?.trecho).toContain('[orçamento]');
  });

  it('não quebra com termo malformado nem com operador do FTS5', () => {
    criarReuniao('r1');
    transcrever('r1', ['o cliente pediu desconto no contrato']);

    // Aspas soltas, asterisco e parêntese estourariam erro de sintaxe no MATCH.
    for (const termo of ['"', '*', 'desconto"', '"desconto', 'NEAR(', '^desconto', 'desconto*']) {
      expect(() => db.buscarNasTranscricoes(termo, 10)).not.toThrow();
    }
    expect(db.buscarNasTranscricoes('desconto"', 10)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('desconto*', 10)).toHaveLength(1);

    // AND/OR/NOT viram texto: procuram a palavra, não o operador.
    expect(db.buscarNasTranscricoes('AND', 10)).toEqual([]);
    expect(db.buscarNasTranscricoes('desconto OR contrato', 10)).toEqual([]);
    // Vários pedaços = todos precisam aparecer.
    expect(db.buscarNasTranscricoes('desconto contrato', 10)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('desconto reembolso', 10)).toEqual([]);
  });

  it('termo vazio ou só pontuação devolve lista vazia, não erro', () => {
    criarReuniao('r1');
    transcrever('r1', ['qualquer coisa dita aqui']);

    for (const termo of ['', '   ', '...', '!!!', '""']) {
      expect(db.buscarNasTranscricoes(termo, 10)).toEqual([]);
    }
  });

  it('respeita o limite (e limite não positivo devolve vazio)', () => {
    for (let i = 1; i <= 4; i += 1) {
      criarReuniao(`r${i}`, `2026-08-0${i}T12:00:00.000Z`);
      transcrever(`r${i}`, [`todo mundo falou de reembolso na reunião ${i}`]);
    }

    expect(db.buscarNasTranscricoes('reembolso', 10)).toHaveLength(4);
    expect(db.buscarNasTranscricoes('reembolso', 2)).toHaveLength(2);
    expect(db.buscarNasTranscricoes('reembolso', 1)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('reembolso', 0)).toEqual([]);
    expect(db.buscarNasTranscricoes('reembolso', -3)).toEqual([]);
  });

  it('o índice acompanha a regravação da transcrição', () => {
    criarReuniao('r1');
    transcrever('r1', ['a primeira versão falava de cancelamento']);
    expect(db.buscarNasTranscricoes('cancelamento', 10)).toHaveLength(1);

    // O worker do Recall pode reprocessar e regravar por cima.
    transcrever('r1', ['agora a transcrição fala de renovação do plano']);
    expect(db.buscarNasTranscricoes('cancelamento', 10)).toEqual([]);
    expect(db.buscarNasTranscricoes('renovação', 10)).toHaveLength(1);
    expect(db.buscarNasTranscricoes('renovacao', 10)[0]?.meetingId).toBe('r1');
  });

  it('aceita o formato antigo (array cru de falas) e ignora JSON estragado', () => {
    criarReuniao('r1');
    db.setMeetingTranscript({
      id: 'r1',
      transcriptJson: JSON.stringify([fala('Maria', 'formato antigo com garantia estendida', 0)]),
      durationSeconds: 1,
    });
    expect(db.buscarNasTranscricoes('garantia', 10).map((a) => a.meetingId)).toEqual(['r1']);

    criarReuniao('r2');
    expect(() =>
      db.setMeetingTranscript({ id: 'r2', transcriptJson: '{isso não é json', durationSeconds: 1 })
    ).not.toThrow();
    expect(db.getMeeting('r2')?.transcript_texto).toBe('');
  });

  it('usa o horário de início quando a reunião já rodou', () => {
    criarReuniao('r1');
    db.updateMeetingStatus('r1', 'recording');
    transcrever('r1', ['tudo certo com a integração']);

    const inicio = db.getMeeting('r1')?.started_at;
    expect(inicio).toBeTruthy();
    expect(db.buscarNasTranscricoes('integração', 10)[0]?.quando).toBe(inicio);
  });
});

describe('migração do índice em banco que já existe', () => {
  it('indexa o que já estava gravado antes do índice existir', () => {
    const db = new Db(':memory:');
    try {
      db.createMeeting({
        id: 'antiga',
        botId: 'bot-antiga',
        sessionId: 'sessao-antiga',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        meetingCode: 'abc-defg-hij',
        botName: null,
        createdAt: T0,
      });
      transcreverDireto(db, 'antiga', 'ficou pendente a assinatura do aditivo');

      // Simula o banco de antes desta feature: some o índice e o texto plano.
      derrubarIndice(db);
      expect(() => db.buscarNasTranscricoes('aditivo', 10)).toThrow();

      // Reabrir roda a migração de novo — e ela precisa ser idempotente.
      migrarDeNovo(db);
      expect(db.buscarNasTranscricoes('aditivo', 10).map((a) => a.meetingId)).toEqual(['antiga']);
      migrarDeNovo(db);
      expect(db.buscarNasTranscricoes('aditivo', 10)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

/**
 * Os helpers abaixo cutucam o SQLite por dentro pra reproduzir um banco antigo.
 * `Db` não expõe a conexão de propósito, então o teste alcança o campo privado —
 * é o único jeito de exercitar a migração sem versionar um .db de fixture.
 */
interface ConexaoInterna {
  exec(sql: string): unknown;
}

function conexao(db: Db): ConexaoInterna {
  return (db as unknown as { db: ConexaoInterna }).db;
}

function transcreverDireto(db: Db, id: string, texto: string): void {
  db.setMeetingTranscript({
    id,
    transcriptJson: JSON.stringify({ falas: [fala('Maria', texto, 0)], participantes: [] }),
    durationSeconds: 1,
  });
}

function derrubarIndice(db: Db): void {
  const c = conexao(db);
  c.exec('DROP TRIGGER meetings_fts_ai');
  c.exec('DROP TRIGGER meetings_fts_ad');
  c.exec('DROP TRIGGER meetings_fts_au');
  c.exec('DROP TABLE meetings_fts');
  c.exec('UPDATE meetings SET transcript_texto = NULL');
}

function migrarDeNovo(db: Db): void {
  (db as unknown as { migrate(): void }).migrate();
}
