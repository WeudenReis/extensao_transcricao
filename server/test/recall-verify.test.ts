import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verificarAssinatura, podeAceitar } from '../src/recall/verify.js';

const SEGREDO = 'whsec_' + Buffer.from('segredo-de-teste-123456').toString('base64');

function assinar(id: string, ts: number, corpo: string): string {
  const chave = Buffer.from(SEGREDO.slice('whsec_'.length), 'base64');
  const assinatura = createHmac('sha256', chave)
    .update(`${id}.${ts}.${corpo}`, 'utf8')
    .digest('base64');
  return `v1,${assinatura}`;
}

const AGORA = 1_800_000_000;
const CORPO = JSON.stringify({ event: 'transcript.done', data: { bot: { id: 'bot_1' } } });

describe('verificação da assinatura do webhook do Recall', () => {
  it('aceita uma assinatura legítima', () => {
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(AGORA),
      webhookSignature: assinar('msg_1', AGORA, CORPO),
      body: CORPO,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(true);
  });

  it('rejeita quando o corpo foi adulterado', () => {
    const assinatura = assinar('msg_1', AGORA, CORPO);
    const adulterado = JSON.stringify({ event: 'transcript.done', data: { bot: { id: 'INVASOR' } } });
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(AGORA),
      webhookSignature: assinatura,
      body: adulterado,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(false);
  });

  it('rejeita assinatura de outro segredo', () => {
    const outra = createHmac('sha256', Buffer.from('outro'))
      .update(`msg_1.${AGORA}.${CORPO}`)
      .digest('base64');
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(AGORA),
      webhookSignature: `v1,${outra}`,
      body: CORPO,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(false);
  });

  it('rejeita mensagem antiga (proteção contra replay)', () => {
    const velho = AGORA - 60 * 60; // 1 hora atrás
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(velho),
      webhookSignature: assinar('msg_1', velho, CORPO),
      body: CORPO,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/replay|janela/i);
  });

  it('rejeita quando faltam os headers', () => {
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: undefined,
      webhookTimestamp: undefined,
      webhookSignature: undefined,
      body: CORPO,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(false);
  });

  it('aceita quando o header traz várias assinaturas e uma delas confere', () => {
    const boa = assinar('msg_1', AGORA, CORPO);
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(AGORA),
      webhookSignature: `v1,assinaturaVelhaQualquer ${boa}`,
      body: CORPO,
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(true);
  });

  it('funciona com o corpo cru em Buffer (como chega do express.raw)', () => {
    const r = verificarAssinatura({
      secret: SEGREDO,
      webhookId: 'msg_1',
      webhookTimestamp: String(AGORA),
      webhookSignature: assinar('msg_1', AGORA, CORPO),
      body: Buffer.from(CORPO, 'utf8'),
      agoraSegundos: AGORA,
    });
    expect(r.ok).toBe(true);
  });
});

describe('política de aceitação do webhook', () => {
  it('sem segredo configurado, REJEITA por padrão', () => {
    const r = podeAceitar({
      secret: '',
      webhookId: 'x', webhookTimestamp: String(AGORA), webhookSignature: 'v1,y',
      body: CORPO, agoraSegundos: AGORA, permitirInseguro: false,
    });
    expect(r.ok).toBe(false);
  });

  it('sem segredo, aceita SOMENTE com ALLOW_INSECURE_RECALL (modo dev)', () => {
    const r = podeAceitar({
      secret: '',
      webhookId: 'x', webhookTimestamp: String(AGORA), webhookSignature: 'v1,y',
      body: CORPO, agoraSegundos: AGORA, permitirInseguro: true,
    });
    expect(r.ok).toBe(true);
  });
});
