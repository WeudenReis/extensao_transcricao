import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError, ehHostLocal } from '../src/config.js';

/**
 * PAINEL_API_URL é o endereço pra onde os dois tokens do painel viajam. Cada
 * GET /me, cada GET /available-slots e cada POST /meetings leva
 * `Authorization: Bearer <token>` — em http:// isso é texto claro a cada clique
 * de cada atendente, exposição contínua e não um vazamento pontual.
 *
 * z.string().url() aceita http:// sem reclamar, então a exigência de TLS mora
 * num refine e derruba o boot: um log.warn de boot ninguém lê, e o servidor
 * subiria vazando token o dia inteiro.
 */

const TOKENS = {
  PAINEL_EXT_AGENDA_TOKEN: 'token-de-agenda-de-mentira',
  PAINEL_RETAGUARDA_TOKEN: 'token-de-retaguarda-de-mentira',
};

describe('PAINEL_API_URL exige TLS fora de host local', () => {
  it('derruba o boot em http:// remoto, e a mensagem diz o porquê', () => {
    const subir = (): unknown => loadConfig({ ...TOKENS, PAINEL_API_URL: 'http://painel.empresa.com.br' });

    expect(subir).toThrow(ConfigError);
    // A pessoa que lê o erro no terminal precisa entender o risco, não só a regra.
    expect(subir).toThrow(/PAINEL_API_URL precisa ser https:\/\//);
    expect(subir).toThrow(/texto claro/);
  });

  it('não deixa passar por porta, caminho, subdomínio parecido ou maiúscula', () => {
    for (const url of [
      'http://painel.empresa.com.br:8080',
      'http://painel.empresa.com.br/api',
      'http://localhost.empresa.com.br', // parece local, mas resolve lá fora
      'http://meu-localhost',
      'http://127.0.0.1.empresa.com.br',
      'http://192.168.0.10:3000', // rede local ainda é rede: tem Wi-Fi e colega
      'HTTP://PAINEL.EMPRESA.COM.BR',
    ]) {
      expect(() => loadConfig({ ...TOKENS, PAINEL_API_URL: url })).toThrow(ConfigError);
    }
  });

  it('aceita https:// em qualquer host', () => {
    const config = loadConfig({ ...TOKENS, PAINEL_API_URL: 'https://painel.empresa.com.br' });
    expect(config.painelApiUrl).toBe('https://painel.empresa.com.br');
    expect(config.painelExtAgendaToken).toBe(TOKENS.PAINEL_EXT_AGENDA_TOKEN);
  });

  it('continua aceitando http:// em host local — o pacote não sai da máquina', () => {
    // Sem esta exceção o ambiente de desenvolvimento (painel rodando em HTTP
    // puro na porta 3000) deixaria de subir, e a regra seria contornada na
    // marra — provavelmente desligando a checagem inteira.
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://127.0.0.2:8080',
      'http://[::1]:3333',
      'http://painel.local',
      'http://painel.local:4000/api',
    ]) {
      expect(loadConfig({ ...TOKENS, PAINEL_API_URL: url }).painelApiUrl).toBe(url);
    }
  });

  it('sem PAINEL_API_URL nada muda: integração desligada continua subindo', () => {
    expect(loadConfig({}).painelApiUrl).toBeUndefined();
  });

  it('URL quebrada e esquema estranho continuam reprovados', () => {
    // O .url() reclama primeiro; o refine não pode transformar isso num erro
    // confuso sobre TLS.
    expect(() => loadConfig({ PAINEL_API_URL: 'painel.empresa.com.br' })).toThrow(
      /PAINEL_API_URL deve ser uma URL válida/
    );
    // ftp:// passa pelo .url() do zod — e não é TLS.
    expect(() => loadConfig({ PAINEL_API_URL: 'ftp://painel.empresa.com.br' })).toThrow(ConfigError);
  });

  it('ehHostLocal separa loopback e *.local de tudo que é remoto', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'painel.local', 'PAINEL.LOCAL']) {
      expect(ehHostLocal(host), host).toBe(true);
    }
    for (const host of ['local', 'painel.empresa.com.br', 'localhost.com.br', 'notlocalhost', '10.0.0.1', '::2']) {
      expect(ehHostLocal(host), host).toBe(false);
    }
  });
});
