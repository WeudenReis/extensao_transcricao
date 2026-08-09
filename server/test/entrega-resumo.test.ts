import { describe, it, expect } from 'vitest';
import { Db } from '../src/db.js';
import { ChatproClient } from '../src/chatpro/client.js';
import { entregarAoChatpro } from '../src/pipeline/recallQueue.js';
import { jsonResponse } from './helpers.js';

/**
 * A decisão de produto: o comentário no chatPro leva SÓ O RESUMO.
 * A transcrição completa continua salva e visível no painel, mas não vai pra
 * conversa do cliente.
 *
 * O que torna isto delicado: sendo o único conteúdo, o resumo não pode ser
 * ponto único de falha. Se a IA não responder, ainda tem que chegar algo útil.
 */

const SESSION = '78562bd7-3d56-47ae-9d4f-25dd80e6b024';

function comTranscricao(db: Db): void {
  db.createMeeting({
    id: 'reuniao-1',
    botId: 'bot-1',
    sessionId: SESSION,
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    meetingCode: 'abc-defg-hij',
    botName: 'chatPro (gravando)',
  });
  db.setMeetingTranscript({
    id: 'reuniao-1',
    transcriptJson: JSON.stringify({
      falas: [
        { speaker: 'Maria', text: 'o prazo é sexta', startMs: 1000, endMs: 3000, isHost: true },
        { speaker: 'João', text: 'combinado', startMs: 4000, endMs: 5000, isHost: false },
      ],
      participantes: [
        { nome: 'Maria', isHost: true, email: null },
        { nome: 'João', isHost: false, email: null },
      ],
    }),
    durationSeconds: 2040,
  });
}

function cliente(chamadas: { body: Record<string, unknown> }[]): ChatproClient {
  const fetchImpl = ((_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    chamadas.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return Promise.resolve(jsonResponse({}, 201));
  }) as typeof fetch;
  return new ChatproClient({
    baseUrl: 'https://sparks.exemplo',
    instanceToken: 'tok',
    instanceId: 'chatpro-1',
    userId: 'user-1',
    fetchImpl,
  });
}

describe('o comentário leva só o resumo', () => {
  it('publica o resumo e NÃO a transcrição', async () => {
    const db = new Db(':memory:');
    comTranscricao(db);
    const chamadas: { body: Record<string, unknown> }[] = [];

    const r = await entregarAoChatpro(db, cliente(chamadas), db.getMeeting('reuniao-1')!, {
      gerarResumoImpl: async () => ({
        combinado: ['Enviar a proposta até sexta'],
        atencao: ['Cliente citou concorrente'],
      }),
    });

    expect(r.ok).toBe(true);
    const texto = String(chamadas[0]?.body.message);
    expect(texto).toContain('Enviar a proposta até sexta');
    expect(texto).toContain('Cliente citou concorrente');
    // A fala literal da transcrição NÃO pode aparecer na conversa.
    expect(texto).not.toContain('o prazo é sexta');
    expect(texto).not.toContain('[00:01]');
  });

  it('resumo indisponível ainda entrega cabeçalho — o cliente nunca fica sem nada', async () => {
    const db = new Db(':memory:');
    comTranscricao(db);
    const chamadas: { body: Record<string, unknown> }[] = [];

    const r = await entregarAoChatpro(db, cliente(chamadas), db.getMeeting('reuniao-1')!, {
      // É o que gerarResumo faz sem ANTHROPIC_API_KEY, em timeout ou resposta
      // inválida: devolve null em vez de lançar.
      gerarResumoImpl: async () => null,
    });

    expect(r.ok).toBe(true);
    const texto = String(chamadas[0]?.body.message);
    expect(texto.length).toBeGreaterThan(20);
    expect(texto).toContain('34 min');
    expect(texto).toContain('Maria');
    expect(texto).toContain('https://meet.google.com/abc-defg-hij');
    expect(texto).not.toContain('o prazo é sexta');
  });

  it('a transcrição continua salva no banco pro painel', async () => {
    const db = new Db(':memory:');
    comTranscricao(db);
    await entregarAoChatpro(db, cliente([]), db.getMeeting('reuniao-1')!, {
      gerarResumoImpl: async () => null,
    });

    const m = db.getMeeting('reuniao-1');
    expect(String(m?.transcript_json)).toContain('o prazo é sexta');
  });
});
