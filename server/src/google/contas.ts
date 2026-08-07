import { OAuth2Client } from 'google-auth-library';
import type { Db, GoogleAccountRow } from '../db.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Conta Google de CADA atendente.
 *
 * Diferente de `google/auth.ts`, que guarda UMA conta (a do servidor, usada no
 * caminho antigo da Meet REST API). Aqui cada instalação da extensão conecta a
 * sua própria conta, identificada por um `deviceId` que a extensão gera e
 * guarda. É com essa conta que o link do Meet é criado — assim a reunião nasce
 * na agenda de quem vai atender, e funciona com **conta pessoal @gmail**.
 *
 * Escopo usado: `calendar.events`. A criação do link é um efeito colateral de
 * criar um evento na agenda (conferenceData) — é o caminho que funciona sem
 * Google Workspace, ao contrário do Meet REST API v2.
 *
 * O refresh token nunca sai daqui: fica cifrado no SQLite e a extensão só vê
 * o e-mail conectado.
 */

const log = createLogger('google/contas');

export const ESCOPOS_AGENDA = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'email',
];

/** Margem antes do expiry pra renovar o access token. */
const MARGEM_EXPIRY_MS = 60_000;

/** TTL do state anti-CSRF. */
const STATE_TTL_MS = 10 * 60_000;

export interface ContasGoogleOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string | undefined;
  db: Db;
}

export class ContasGoogle {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly db: Db;
  private readonly encryptionKey: string | undefined;
  /** state → { deviceId, expira }. Em memória: o fluxo dura 10 min. */
  private readonly states = new Map<string, { deviceId: string; expira: number }>();

  constructor(options: ContasGoogleOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.db = options.db;
    this.encryptionKey = options.tokenEncryptionKey;
  }

  estaConfigurado(): boolean {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  private novoClient(): OAuth2Client {
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
    });
  }

  /** URL do consent do Google pra este dispositivo. */
  urlDeConsentimento(deviceId: string, state: string): string {
    this.limparStatesVencidos();
    this.states.set(state, { deviceId, expira: Date.now() + STATE_TTL_MS });
    return this.novoClient().generateAuthUrl({
      access_type: 'offline',
      scope: ESCOPOS_AGENDA,
      state,
      // 'consent' força o Google a devolver refresh_token mesmo em reconexão.
      prompt: 'consent',
      include_granted_scopes: true,
    });
  }

  /** Troca o `code` e guarda a conta. Devolve o e-mail conectado. */
  async concluirConexao(code: string, state: string): Promise<{ deviceId: string; email: string | null }> {
    const pendente = this.states.get(state);
    this.states.delete(state);
    if (!pendente || pendente.expira < Date.now()) {
      throw new Error('State inválido ou vencido — refaça a conexão pela extensão.');
    }

    const client = this.novoClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        'O Google não devolveu refresh_token. Remova o acesso em ' +
          'myaccount.google.com/permissions e conecte de novo.'
      );
    }

    const email = await this.lerEmail(client, tokens.id_token ?? null);
    this.db.salvarContaGoogle({
      deviceId: pendente.deviceId,
      email,
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token, this.encryptionKey),
      accessToken: tokens.access_token ?? null,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    });
    log.info(`conta Google conectada pelo dispositivo ${pendente.deviceId}: ${email ?? '(sem e-mail)'}`);
    return { deviceId: pendente.deviceId, email };
  }

  /** Access token válido do dispositivo, renovando quando vencido. */
  async accessToken(deviceId: string): Promise<string> {
    const conta = this.db.buscarContaGoogle(deviceId);
    if (!conta) {
      throw new ContaNaoConectada(deviceId);
    }
    if (conta.access_token && conta.expiry) {
      const restante = Date.parse(conta.expiry) - Date.now();
      if (Number.isFinite(restante) && restante > MARGEM_EXPIRY_MS) return conta.access_token;
    }

    const client = this.novoClient();
    client.setCredentials({
      refresh_token: decryptSecret(conta.refresh_token_encrypted, this.encryptionKey),
    });

    let token: string | null | undefined;
    try {
      ({ token } = await client.getAccessToken());
    } catch (err) {
      // `invalid_grant` = o refresh token morreu. Acontece por três motivos, e
      // o primeiro é o mais comum aqui: com o app OAuth em "Testing" e tipo
      // Externo, o Google EXPIRA o refresh token em 7 dias. Também acontece se
      // a pessoa revogar o acesso, ou se a senha do Google mudar.
      //
      // Sem esta guarda o erro subia como 502 genérico ("não foi possível criar
      // o link"), e a saída — reconectar a conta — não ficava óbvia pra ninguém.
      if (ehGrantInvalido(err)) {
        log.warn(`refresh token do dispositivo ${deviceId} não vale mais — precisa reconectar.`);
        throw new ContaGoogleExpirada(deviceId);
      }
      throw err;
    }
    if (!token) throw new Error('Google não devolveu access token na renovação.');

    const expiry = client.credentials.expiry_date
      ? new Date(client.credentials.expiry_date).toISOString()
      : null;
    this.db.atualizarAccessTokenGoogle(deviceId, token, expiry);
    return token;
  }

  status(deviceId: string): { conectado: boolean; email: string | null } {
    const conta: GoogleAccountRow | undefined = this.db.buscarContaGoogle(deviceId);
    return { conectado: Boolean(conta), email: conta?.email ?? null };
  }

  desconectar(deviceId: string): void {
    this.db.removerContaGoogle(deviceId);
    log.info(`conta Google do dispositivo ${deviceId} removida.`);
  }

  /** E-mail do id_token — só pra mostrar "conectado como" na extensão. */
  private async lerEmail(client: OAuth2Client, idToken: string | null): Promise<string | null> {
    if (!idToken) return null;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: this.clientId });
      return ticket.getPayload()?.email ?? null;
    } catch (err) {
      log.warn(`não deu pra ler o e-mail do id_token: ${errorMessage(err)}`);
      return null;
    }
  }

  private limparStatesVencidos(): void {
    const agora = Date.now();
    for (const [s, v] of this.states) {
      if (v.expira < agora) this.states.delete(s);
    }
  }
}

export class ContaNaoConectada extends Error {
  constructor(
    readonly deviceId: string,
    mensagem = 'Esta instalação ainda não conectou uma conta Google.'
  ) {
    super(mensagem);
    this.name = 'ContaNaoConectada';
  }
}

/**
 * A conta ESTAVA conectada, mas o refresh token não vale mais.
 *
 * Herda de ContaNaoConectada de propósito: pra quem chama, a saída é a mesma
 * (mandar reconectar pela extensão), então o tratamento que já existe serve —
 * só a mensagem muda, pra pessoa não achar que nunca conectou.
 */
export class ContaGoogleExpirada extends ContaNaoConectada {
  constructor(deviceId: string) {
    super(
      deviceId,
      'A conexão com o Google expirou. Isso acontece a cada 7 dias enquanto o ' +
        'app OAuth estiver em modo de teste — publique em produção pra parar de acontecer.'
    );
    this.name = 'ContaGoogleExpirada';
  }
}

/** O Google devolve `invalid_grant` quando o refresh token morreu. */
function ehGrantInvalido(err: unknown): boolean {
  const texto = (
    err instanceof Error ? `${err.message} ${JSON.stringify((err as { response?: unknown }).response ?? '')}` : String(err)
  ).toLowerCase();
  return texto.includes('invalid_grant') || texto.includes('token has been expired or revoked');
}
