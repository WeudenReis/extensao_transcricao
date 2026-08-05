import { OAuth2Client } from 'google-auth-library';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * OAuth2 Authorization Code do Google.
 *
 * - GET /oauth/start    → redireciona pro consent screen
 * - GET /oauth/callback → troca o code, persiste refresh token cifrado
 * - getAccessToken()    → devolve access token válido, renovando quando expira
 *
 * O refresh token é cifrado com AES-256-GCM (TOKEN_ENCRYPTION_KEY). Sem a
 * chave, salva em texto puro com warning claro (modo dev).
 */

const log = createLogger('google/auth');

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.settings',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'openid',
  'email',
];

/** Margem antes do expiry para renovar o access token. */
const EXPIRY_MARGIN_MS = 60_000;

/** TTL do state anti-CSRF do fluxo OAuth. */
const STATE_TTL_MS = 10 * 60_000;

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string | undefined;
  db: Db;
  /** Chamado após um callback OAuth bem-sucedido (ex.: criar subscription). */
  onConnected?: () => void;
}

export class GoogleAuth {
  private readonly client: OAuth2Client;
  private readonly db: Db;
  private readonly encryptionKey: string | undefined;
  private readonly onConnected: (() => void) | undefined;
  /** state anti-CSRF → expiração (ms). Em memória: single user, TTL 10 min. */
  private readonly pendingStates = new Map<string, number>();

  constructor(options: GoogleAuthOptions) {
    this.client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
    });
    this.db = options.db;
    this.encryptionKey = options.tokenEncryptionKey;
    this.onConnected = options.onConnected;
    if (!this.encryptionKey) {
      log.warn(
        'TOKEN_ENCRYPTION_KEY não definida — o refresh token do Google será salvo em TEXTO PURO. ' +
          'Use apenas em desenvolvimento; defina a chave no .env para produção.'
      );
    }
  }

  buildAuthUrl(): string {
    const state = randomUUID();
    this.prunePendingStates();
    this.pendingStates.set(state, Date.now() + STATE_TTL_MS);
    return this.client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state,
    });
  }

  /**
   * Valida e CONSOME o state do callback (uso único).
   * false = desconhecido, já usado ou expirado → rejeitar com 403 (CSRF).
   */
  consumeState(state: string): boolean {
    const expiresAt = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private prunePendingStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.pendingStates) {
      if (expiresAt <= now) this.pendingStates.delete(state);
    }
  }

  async handleCallback(code: string): Promise<{ email: string | undefined }> {
    const { tokens } = await this.client.getToken(code);

    const existing = this.db.getGoogleTokens();
    let refreshTokenEncrypted: string;
    if (tokens.refresh_token) {
      refreshTokenEncrypted = encryptSecret(tokens.refresh_token, this.encryptionKey);
    } else if (existing) {
      // Google só devolve refresh_token no primeiro consent — mantém o que temos.
      refreshTokenEncrypted = existing.refresh_token_encrypted;
    } else {
      throw new Error(
        'Google não devolveu refresh_token. Remova o acesso do app em myaccount.google.com/permissions e refaça /oauth/start.'
      );
    }

    this.db.saveGoogleTokens({
      refreshTokenEncrypted,
      accessToken: tokens.access_token ?? null,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    });

    let email: string | undefined;
    if (tokens.id_token) {
      email = decodeJwtEmail(tokens.id_token);
    }
    log.info(`Google conectado${email ? ` como ${email}` : ''} (refresh token persistido).`);
    if (this.onConnected) {
      try {
        this.onConnected();
      } catch (err) {
        log.warn(`callback onConnected falhou: ${errorMessage(err)}`);
      }
    }
    return { email };
  }

  isConnected(): boolean {
    return this.db.getGoogleTokens() !== undefined;
  }

  /** Devolve um access token válido, renovando via refresh token se preciso. */
  async getAccessToken(): Promise<string> {
    const row = this.db.getGoogleTokens();
    if (!row) {
      throw new Error('Google não conectado — abra http://localhost:PORT/oauth/start no navegador.');
    }

    if (row.access_token && row.expiry && Date.parse(row.expiry) - EXPIRY_MARGIN_MS > Date.now()) {
      return row.access_token;
    }

    const refreshToken = decryptSecret(row.refresh_token_encrypted, this.encryptionKey);
    this.client.setCredentials({ refresh_token: refreshToken });
    const { token } = await this.client.getAccessToken();
    if (!token) {
      throw new Error('Falha ao renovar access token do Google (resposta vazia).');
    }
    const expiryDate = this.client.credentials.expiry_date;
    this.db.updateAccessToken(token, expiryDate ? new Date(expiryDate).toISOString() : null);
    log.debug('access token renovado.');
    return token;
  }
}

/** Extrai o e-mail do payload de um JWT sem validar assinatura (uso informativo). */
function decodeJwtEmail(idToken: string): string | undefined {
  try {
    const parts = idToken.split('.');
    const payloadPart = parts[1];
    if (!payloadPart) return undefined;
    const json: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (json && typeof json === 'object' && 'email' in json) {
      const email = (json as { email: unknown }).email;
      return typeof email === 'string' ? email : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createOAuthRouter(auth: GoogleAuth): Router {
  const router = Router();

  router.get('/oauth/start', (_req, res) => {
    res.redirect(auth.buildAuthUrl());
  });

  router.get('/oauth/callback', async (req, res) => {
    // Anti-CSRF: o state gerado em /oauth/start precisa voltar intacto.
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (!state || !auth.consumeState(state)) {
      log.warn('callback OAuth rejeitado: state ausente, desconhecido ou expirado (possível CSRF).');
      res
        .status(403)
        .send('State inválido ou expirado — refaça o fluxo abrindo /oauth/start de novo.');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    if (!code) {
      res.status(400).send('Parâmetro "code" ausente na URL de callback.');
      return;
    }
    try {
      const { email } = await auth.handleCallback(code);
      res
        .status(200)
        .send(
          `<h1>Google conectado ✔</h1><p>${email ? `Conta: ${email}. ` : ''}` +
            'Pode fechar esta aba — o backend já está autorizado.</p>'
        );
    } catch (err) {
      log.error('falha no callback OAuth', err);
      res.status(500).send(`Falha ao concluir OAuth: ${errorMessage(err)}`);
    }
  });

  return router;
}
