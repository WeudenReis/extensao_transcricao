import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { montarDadosDoPainel, iniciarSchema } from '../src/routes/reunioes.js';
import { PainelClient } from '../src/painel/client.js';
import { createPainelInternoRouter } from '../src/routes/painelInterno.js';
import { jsonResponse } from './helpers.js';

/**
 * Os campos que cada TIPO de reunião exige.
 *
 * O problema que estes testes guardam é de produto, não de código: o formulário
 * pedia nome/empresa/telefone/CNPJ/instância/provedor e mandava. O painel
 * recusava com 422 — depois de a pessoa ter preenchido tudo — porque faltava
 * `cs_reason` no CS e `vendedor_email` na migração.
 *
 * Aqui ficam as duas metades disso no servidor:
 *  - o corpo montado pro painel leva os campos certos de cada tipo
 *  - `assignee_email` só sai quando a ABA mandou (ela só manda com permissão do
 *    `/me`); preencher por conta própria daria 403 pra quem não é supervisor
 */

const CNPJ = '11.222.333/0001-81';
const EU = 'atendente@empresa.com';

/** Cliente completo — cada teste tira ou põe só o campo que está medindo. */
function cliente(extras: Record<string, unknown> = {}): never {
  return {
    nome: 'Maria Souza',
    cnpj: CNPJ,
    instancia: 'chatpro-abc123',
    telefone: '(11) 98888-7777',
    empresa: 'Souza Ltda',
    ...extras,
  } as never;
}

function montar(tipo: string, extras: Record<string, unknown> = {}): ReturnType<
  typeof montarDadosDoPainel
> {
  return montarDadosDoPainel({
    tipo,
    atendenteEmail: EU,
    vendedorEmail: null,
    cliente: cliente(),
    contato: 'Maria',
    quando: new Date('2026-08-21T14:00:00-03:00'),
    ...extras,
  });
}

describe('CS exige o motivo do atendimento', () => {
  it('sem cs_reason o campo não é inventado — quem recusa é o painel', () => {
    // Nada de trava aqui: um desvio silencioso pro plano B criaria uma reunião
    // que existe pro cliente e não existe no painel. Sem `cs_reason` o POST
    // volta 422 dizendo o que falta, e a aba mostra a frase.
    const dados = montar('cs', { cliente: cliente({ provedor: 'starter' }) });

    expect(dados).not.toBeNull();
    expect(dados).not.toHaveProperty('csReason');
  });

  it('com cs_reason o motivo vai junto do provedor', () => {
    const dados = montar('cs', {
      cliente: cliente({ provedor: 'cloud_api', csReason: 'retencao' }),
    });

    expect(dados).toMatchObject({ type: 'cs', provedor: 'cloud_api', csReason: 'retencao' });
  });

  it('o schema recusa motivo que o painel não conhece', () => {
    // Enum, não string livre: um valor inventado passaria daqui e só quebraria
    // no painel, com o formulário inteiro preenchido.
    const corpo = {
      sessionId: '6f1c2a5e-6a3d-4a2a-9c3e-8b1f0a2d4c55',
      deviceId: 'dispositivo-de-teste',
      tipo: 'cs',
      atendenteEmail: EU,
      cliente: cliente({ provedor: 'starter', csReason: 'motivo_inventado' }),
    };

    expect(iniciarSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('migração exige o vendedor da conta', () => {
  it('sem vendedor_email o campo fica ausente — o painel é quem recusa', () => {
    const dados = montar('migracao', { cliente: cliente({ clientType: 'base' }) });

    expect(dados).not.toBeNull();
    expect(dados).not.toHaveProperty('vendedorEmail');
  });

  it('com vendedor_email a migração sobe', () => {
    const dados = montar('migracao', {
      cliente: cliente({ clientType: 'base' }),
      vendedorEmail: 'vendedor@empresa.com',
    });

    expect(dados).toMatchObject({
      type: 'migracao',
      vendedorEmail: 'vendedor@empresa.com',
      clientType: 'base',
      cnpj: CNPJ,
      instanceCode: 'chatpro-abc123',
    });
  });
});

describe('assignee_email só sai quando a aba mandou', () => {
  it('sem escolha de responsável o campo nem existe no corpo', () => {
    // Ausência é diferente de vazio: o painel devolve 403 ("Só supervisor pode
    // escolher o responsável") pra QUALQUER assignee_email vindo de quem não
    // pode — e a reunião nem chega a ser criada.
    const dados = montar('apresentacao');

    expect(dados).not.toBeNull();
    expect(dados).not.toHaveProperty('assigneeEmail');
  });

  it('escolhido na aba, vai como assigneeEmail e não como vendedorEmail', () => {
    // São campos diferentes na API: `vendedor_email` é o dono da conta,
    // `assignee_email` é quem conduz. Trocar um pelo outro atribui a reunião
    // pra pessoa errada sem ninguém perceber.
    const dados = montar('apresentacao', { assigneeEmail: 'supervisora@empresa.com' });

    expect(dados).toMatchObject({ assigneeEmail: 'supervisora@empresa.com' });
    expect(dados).not.toHaveProperty('vendedorEmail');
  });
});

/**
 * O checklist de migração é pré-requisito do painel: sem ele o POST recusa com
 * "Nenhum checklist de migração ativo para este CNPJ". A aba precisa saber
 * disso quando o CNPJ fica válido, não no fim do formulário.
 */
describe('GET /api/painel/onboarding — temChecklist', () => {
  const servidores: Server[] = [];
  afterEach(() => {
    for (const s of servidores.splice(0)) s.close();
  });

  async function subir(responder: (url: string) => Response): Promise<string> {
    const painel = new PainelClient({
      baseUrl: 'https://painel.exemplo',
      extAgendaToken: 'token-ext-agenda',
      retaguardaToken: 'token-retaguarda',
      fetchImpl: ((): Promise<Response> =>
        Promise.resolve(responder(''))) as unknown as typeof fetch,
      timeoutMs: 50,
    });
    const app = express();
    app.use(createPainelInternoRouter({ painel }));
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servidores.push(server);
    const addr = server.address();
    const porta = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${porta}`;
  }

  async function consultar(base: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${base}/api/painel/onboarding?cnpj=${encodeURIComponent(CNPJ)}`);
    return (await r.json()) as Record<string, unknown>;
  }

  it('checklist ativo devolve temChecklist true', async () => {
    const base = await subir(() =>
      jsonResponse({ success: true, data: { found: true, razao_social: 'Souza Ltda' } })
    );

    expect(await consultar(base)).toMatchObject({ encontrado: true, temChecklist: true });
  });

  it('404 do painel (CNPJ sem checklist) devolve temChecklist false', async () => {
    // É a resposta REAL do painel pra CNPJ sem onboarding — e o motivo do 422
    // que a pessoa levava depois de preencher tudo.
    const base = await subir(() => jsonResponse({ found: false }, 404));

    expect(await consultar(base)).toMatchObject({ encontrado: false, temChecklist: false });
  });

  it('200 com found:false também é ausência de checklist', async () => {
    const base = await subir(() => jsonResponse({ success: true, data: { found: false } }));

    const corpo = await consultar(base);
    // `encontrado` continua true (o painel respondeu algo sobre o CNPJ), mas
    // não há checklist — são duas perguntas diferentes.
    expect(corpo).toMatchObject({ encontrado: true, temChecklist: false });
  });
});
