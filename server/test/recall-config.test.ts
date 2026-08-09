import { describe, it, expect } from 'vitest';
import { loadConfig, recallConfigWarnings, ConfigError } from '../src/config.js';

/** Envs do Recall.ai/chatPro: todas opcionais — o servidor sobe sem nenhuma. */

describe('configuração do Recall.ai', () => {
  it('sobe sem nenhuma variável, com os padrões certos', () => {
    const config = loadConfig({});

    expect(config.recallApiKey).toBeUndefined();
    expect(config.recallRegion).toBe('us-west-2');
    expect(config.recallBotName).toBe('chatPro (gravando)');
    expect(config.recallWebhookSecret).toBeUndefined();
    expect(config.allowInsecureRecall).toBe(false);
    expect(config.publicBaseUrl).toBeUndefined();
    // O contrato real do chatPro Chat é base + instance-token, não url + key.
    expect(config.chatproBaseUrl).toBe('https://sparks.chatpro.com.br');
    expect(config.chatproInstanceToken).toBeUndefined();
    expect(config.autoSendChatpro).toBe(false);
  });

  it('lê os valores e trata as flags como booleanas por string "true"', () => {
    const config = loadConfig({
      RECALL_API_KEY: 'chave-fake',
      RECALL_REGION: 'eu-central-1',
      RECALL_WEBHOOK_SECRET: 'whsec_fake',
      RECALL_BOT_NAME: 'chatPro (gravando a reunião)',
      ALLOW_INSECURE_RECALL: 'true',
      PUBLIC_BASE_URL: 'https://tunel.exemplo.app',
      CHATPRO_API_URL: 'https://api.chatpro.com.br/transcricoes',
      CHATPRO_API_KEY: 'chatpro-fake',
      AUTO_SEND_CHATPRO: 'true',
    });

    expect(config.recallRegion).toBe('eu-central-1');
    expect(config.recallBotName).toBe('chatPro (gravando a reunião)');
    expect(config.allowInsecureRecall).toBe(true);
    expect(config.autoSendChatpro).toBe(true);
    expect(config.publicBaseUrl).toBe('https://tunel.exemplo.app');

    // Qualquer coisa diferente de 'true' é falso — sem "1"/"yes" ambíguos.
    expect(loadConfig({ AUTO_SEND_CHATPRO: '1' }).autoSendChatpro).toBe(false);
  });

  it('recusa região desconhecida e URL inválida com mensagem clara', () => {
    expect(() => loadConfig({ RECALL_REGION: 'br-south-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ CHATPRO_BASE_URL: 'nao-e-url' })).toThrow(/CHATPRO_BASE_URL/);
    // Segredo curto demais é adivinhável — e é ele que protege a criação de bots.
    expect(() => loadConfig({ CHATPRO_WEBHOOK_SECRET: 'curto' })).toThrow(/CHATPRO_WEBHOOK_SECRET/);
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'nao-e-url' })).toThrow(/PUBLIC_BASE_URL/);
  });

  it('avisa o que falta sem jamais expor o valor das chaves', () => {
    const avisos = recallConfigWarnings(loadConfig({}));

    expect(avisos.join(' ')).toContain('RECALL_API_KEY');
    expect(avisos.join(' ')).toContain('403');
    expect(avisos.join(' ')).toContain('PANEL_TOKEN');
    expect(avisos.join(' ')).toContain('CHATPRO_INSTANCE_TOKEN');
    expect(avisos).toHaveLength(6);

    const completo = recallConfigWarnings(
      loadConfig({
        RECALL_API_KEY: 'chave-fake',
        RECALL_WEBHOOK_SECRET: 'whsec_fake',
        PUBLIC_BASE_URL: 'https://tunel.exemplo.app',
        CHATPRO_INSTANCE_TOKEN: 'token-fake',
        CHATPRO_INSTANCE_ID: 'chatpro-1234567890',
        CHATPRO_USER_ID: 'user-fake',
        CHATPRO_WEBHOOK_SECRET: 'segredo-de-webhook-fake',
        PANEL_TOKEN: 'token-longo-o-suficiente',
      })
    );
    expect(completo).toEqual([]);

    // Servidor exposto sem tranca é o caso grave: o aviso tem que dizer isso.
    const exposto = recallConfigWarnings(
      loadConfig({ PUBLIC_BASE_URL: 'https://tunel.exemplo.app' })
    );
    expect(exposto.join(' ')).toContain('lê as transcrições');

    // Em modo inseguro o aviso muda de tom, mas continua sem citar o segredo.
    const inseguro = recallConfigWarnings(loadConfig({ ALLOW_INSECURE_RECALL: 'true' }));
    expect(inseguro.join(' ')).toContain('ALLOW_INSECURE_RECALL=true');
    expect(inseguro.join(' ')).not.toContain('whsec_');
  });
});
