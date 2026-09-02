import { describe, it, expect, afterEach } from 'vitest';
import { Db } from '../src/db.js';

/**
 * A busca do HISTÓRICO: "marquei uma reunião pra segunda, hoje é sexta,
 * cadê?". Procura por nome, razão social, CNPJ ou código de instância e
 * devolve as reuniões do cliente com o session_id — que é o que leva o
 * atendente de volta à conversa certa.
 */

let db: Db;
afterEach(() => db?.close());

function reuniao(over: Partial<Parameters<Db['createMeeting']>[0]> & { id: string }): void {
  db.createMeeting({
    botId: null,
    sessionId: `sessao-${over.id}`,
    meetingUrl: `https://meet.google.com/abc-defg-${over.id}`,
    meetingCode: null,
    botName: null,
    atendenteEmail: 'weuden.filho@chatpro.com.br',
    tipo: 'cs',
    ...over,
  });
}

function comCliente(id: string, cliente: Record<string, unknown>, agendadaPara?: string): void {
  reuniao({ id, clienteJson: JSON.stringify(cliente), agendadaPara: agendadaPara ?? null });
}

describe('buscarReunioes', () => {
  it('acha por nome, razão social, CNPJ mascarado e instância', () => {
    db = new Db(':memory:');
    comCliente('a1', {
      nome: 'Lonan Maquinas',
      empresa: 'SADDI E SANTOS LTDA',
      cnpj: '12.345.678/0001-90',
      instancia: 'chatpro-fz5qbe2haz',
    });
    comCliente('b2', { nome: 'Outra Pessoa', empresa: 'Empresa Sem Relacao' });

    // O MESMO cliente tem que aparecer pelos quatro caminhos de memória que
    // um atendente realmente usa — inclusive digitando o CNPJ SEM máscara,
    // que é como ele chega colado de outro sistema.
    for (const termo of ['lonan', 'saddi', '12345678', '12.345.678', 'fz5qbe2haz']) {
      const r = db.buscarReunioes(termo);
      expect(r.map((x) => x.id)).toEqual(['a1']);
    }
    expect(db.buscarReunioes('sessao-a1')[0]).toBeUndefined();
  });

  it('ignora acento nos dois lados — ninguém digita acento em busca', () => {
    db = new Db(':memory:');
    comCliente('c3', { nome: 'João da Conceição', empresa: 'AÇOUGUE SÃO JOSÉ LTDA' });
    expect(db.buscarReunioes('joao').length).toBe(1);
    expect(db.buscarReunioes('acougue sao').length).toBe(1);
    expect(db.buscarReunioes('JOÃO').length).toBe(1);
  });

  it('ordena pelo horário DA REUNIÃO — a de segunda em cima, mesmo marcada antes', () => {
    db = new Db(':memory:');
    // Marcada primeiro, mas acontece SEGUNDA (mais tarde).
    comCliente('seg', { nome: 'Cliente Duplo' }, '2026-09-07T13:00:00.000Z');
    // Marcada depois, aconteceu na hora ("agora" → sem agendada_para).
    comCliente('hoje', { nome: 'Cliente Duplo' });

    const r = db.buscarReunioes('cliente duplo');
    expect(r.map((x) => x.id)).toEqual(['seg', 'hoje']);
    expect(r[0]?.agendada_para).toBe('2026-09-07T13:00:00.000Z');
    // O session_id viaja junto: é ele que abre a conversa certa no chatPro.
    expect(r[0]?.session_id).toBe('sessao-seg');
  });

  it('termo curto demais devolve vazio em vez de varrer tudo', () => {
    db = new Db(':memory:');
    comCliente('d4', { nome: 'Ana' });
    expect(db.buscarReunioes('a')).toEqual([]);
    // ...mas 4+ dígitos valem como busca de CNPJ mesmo curtinha de letras.
    comCliente('e5', { nome: 'X', cnpj: '99.888.777/0001-66' });
    expect(db.buscarReunioes('9988').map((x) => x.id)).toEqual(['e5']);
  });

  it('JSON quebrado não derruba a busca — a linha só fica de fora', () => {
    db = new Db(':memory:');
    reuniao({ id: 'f6', clienteJson: '{isso nao é json' });
    comCliente('g7', { nome: 'Cliente Bom' });
    expect(db.buscarReunioes('cliente bom').map((x) => x.id)).toEqual(['g7']);
  });
});
