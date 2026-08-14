import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createLogger } from './log.js';

/**
 * Persistência em SQLite (better-sqlite3) com migrations inline.
 * Para testes, use `new Db(':memory:')`.
 */

const log = createLogger('db');

// ─── Tipos das linhas ────────────────────────────────────────────────────────

export interface LinkRow {
  id: number;
  session_id: string;
  meeting_code: string;
  space_name: string | null;
  conference_record: string | null;
  linked_at: string;
  source: string;
}

export interface TranscriptSentRow {
  id: number;
  conference_record: string;
  transcript_name: string;
  session_id: string | null;
  sent_to_voreo_at: string | null;
  voreo_status: string;
  payload_json: string | null;
}

export interface GoogleTokensRow {
  id: number;
  refresh_token_encrypted: string;
  access_token: string | null;
  expiry: string | null;
}

export interface SubscriptionRow {
  name: string;
  target_resource: string;
  expire_time: string | null;
}

export interface VoreoQueueRow {
  id: number;
  payload_json: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

export type CaptureStatus =
  | 'recording'
  | 'pending'
  | 'transcribing'
  | 'ready-for-review'
  | 'sent'
  | 'failed';

export interface CaptureRow {
  id: string;
  session_id: string | null;
  meeting_code: string | null;
  mode: string;
  mime_type: string | null;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
  status: string;
  coverage_ratio: number | null;
  gaps_json: string | null;
  stt_provider: string | null;
  transcript_json: string | null;
  voreo_status: string | null;
  error: string | null;
}

export interface CaptionRow {
  id: number;
  capture_id: string;
  seq: number;
  speaker: string;
  text: string;
  at: string;
}

export interface CaptureHeartbeatRow {
  id: number;
  capture_id: string;
  at: string;
  capturing: number;
  in_call: number;
  mic_active: number;
  remote_tracks: number;
  bytes_sent: number;
}

export type EventStatus = 'pending' | 'done' | 'dead' | 'no-link';

export interface EventQueueRow {
  id: number;
  ce_type: string;
  resource_name: string;
  payload_json: string | null;
  space_name: string | null;
  attempts: number;
  next_attempt_at: string | null;
  status: string;
  created_at: string;
  last_error: string | null;
}

/** Conta Google conectada por uma instalação da extensão. */
export interface GoogleAccountRow {
  device_id: string;
  email: string | null;
  refresh_token_encrypted: string;
  access_token: string | null;
  expiry: string | null;
  created_at: string;
  updated_at: string;
}

/** Convite agendado: sai perto do horário da reunião, não na hora de marcar. */
export interface EnvioAgendadoRow {
  id: number;
  meeting_id: string;
  session_id: string;
  instance_id: string | null;
  message: string;
  enviar_em: string;
  /** Início da reunião — resolve o "hoje/amanhã" no momento do envio. */
  reuniao_em: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

// ─── Recall.ai ───────────────────────────────────────────────────────────────

/** Ciclo de vida da reunião gravada pelo bot do Recall. */
export type MeetingStatus =
  | 'created'
  | 'joining'
  | 'waiting_room'
  | 'recording'
  | 'ended'
  | 'done'
  | 'failed';

export type ChatproStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'skipped-no-url'
  /** Reunião sem gravação: avisamos na conversa em vez de entregar transcrição. */
  | 'aviso-enviado';

export interface MeetingRow {
  id: string;
  bot_id: string | null;
  session_id: string | null;
  meeting_url: string;
  meeting_code: string | null;
  status: string;
  bot_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  transcript_json: string | null;
  /** Só o texto das falas, sem o JSON em volta — é o que o índice FTS5 lê. */
  transcript_texto: string | null;
  duration_seconds: number | null;
  chatpro_status: string | null;
  /** Instância do chatPro dona da conversa — vem no webhook, cai no .env. */
  chatpro_instance_id: string | null;
  /** Partes do comentário já entregues; o reenvio continua daqui. */
  chatpro_parts_sent: number;
  /** Quem marcou — e-mail do @chatpro:auth. É a chave de atribuição. */
  atendente_email: string | null;
  /** apresentacao | migracao | implantacao | cs */
  tipo: string | null;
  /** { nome, cnpj, instancia, telefone } quando o tipo exige. */
  cliente_json: string | null;
  /** Palavras-chave achadas na transcrição (JSON de strings). */
  palavras_json: string | null;
  error: string | null;
  created_at: string;
}

export type RecallEventStatus = 'pending' | 'done' | 'dead';

export interface RecallEventRow {
  id: number;
  webhook_id: string | null;
  event: string;
  bot_id: string | null;
  payload_json: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  last_error: string | null;
}

// ─── Busca nas transcrições ──────────────────────────────────────────────────

/** Uma reunião que casou com o termo procurado. */
export interface ResultadoBusca {
  meetingId: string;
  sessionId: string | null;
  meetingCode: string | null;
  /** Início da reunião; cai no horário de criação quando ela nem começou. */
  quando: string;
  /** Contexto ao redor do termo, com o casamento entre colchetes. */
  trecho: string;
}

/** Quanto contexto o snippet() devolve em volta do termo. */
const PALAVRAS_NO_TRECHO = 16;

/**
 * Transforma o que o atendente digitou numa expressão MATCH segura.
 *
 * Só sobrevivem letras, números e `_`; cada pedaço vira uma FRASE entre aspas.
 * Isso é o que impede `"`, `*`, `AND`, `NEAR(` e companhia de chegarem no
 * parser do FTS5 como operador e estourarem erro de sintaxe — entre aspas eles
 * são texto comum. Vários pedaços = AND implícito (todos precisam aparecer).
 * Termo sem nenhum pedaço aproveitável devolve string vazia.
 */
function montarConsultaFts(termo: string): string {
  const pedacos = termo.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return pedacos.map((pedaco) => `"${pedaco}"`).join(' ');
}

/**
 * Achata o `transcript_json` no texto corrido das falas — é isso, e só isso,
 * que vai pro índice. Nome de quem falou e marcação de tempo ficam de fora pra
 * não poluir o trecho devolvido na busca.
 *
 * Aceita os dois formatos que já existem no banco: `{ falas: [...] }` (Recall)
 * e o array cru de falas (gravações antigas). JSON estragado vira texto vazio:
 * uma linha ilegível não pode derrubar quem só está gravando a reunião.
 */
function textoDasFalas(transcriptJson: string | null): string {
  if (!transcriptJson) return '';
  let bruto: unknown;
  try {
    bruto = JSON.parse(transcriptJson);
  } catch {
    return '';
  }
  const textos: string[] = [];
  for (const fala of falasDe(bruto)) {
    if (typeof fala !== 'object' || fala === null) continue;
    const texto = (fala as { text?: unknown }).text;
    if (typeof texto === 'string' && texto.trim() !== '') textos.push(texto.trim());
  }
  return textos.join(' ');
}

function falasDe(bruto: unknown): unknown[] {
  if (Array.isArray(bruto)) return bruto;
  if (typeof bruto === 'object' && bruto !== null) {
    const falas = (bruto as { falas?: unknown }).falas;
    if (Array.isArray(falas)) return falas;
  }
  return [];
}

// ─── Db ──────────────────────────────────────────────────────────────────────

export class Db {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      const dir = dirname(resolve(databasePath));
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    if (databasePath !== ':memory:') {
      log.info(`banco aberto em ${resolve(databasePath)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        meeting_code TEXT NOT NULL,
        space_name TEXT,
        conference_record TEXT,
        linked_at TEXT NOT NULL,
        source TEXT NOT NULL,
        UNIQUE (session_id, meeting_code)
      );

      CREATE TABLE IF NOT EXISTS transcripts_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conference_record TEXT NOT NULL,
        transcript_name TEXT NOT NULL UNIQUE,
        session_id TEXT,
        sent_to_voreo_at TEXT,
        voreo_status TEXT NOT NULL,
        payload_json TEXT
      );

      CREATE TABLE IF NOT EXISTS google_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        refresh_token_encrypted TEXT NOT NULL,
        access_token TEXT,
        expiry TEXT
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        name TEXT PRIMARY KEY,
        target_resource TEXT NOT NULL,
        expire_time TEXT
      );

      CREATE TABLE IF NOT EXISTS voreo_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS event_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ce_type TEXT NOT NULL,
        resource_name TEXT NOT NULL,
        payload_json TEXT,
        space_name TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        meeting_code TEXT,
        mode TEXT NOT NULL,
        mime_type TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        stop_reason TEXT,
        status TEXT NOT NULL DEFAULT 'recording',
        coverage_ratio REAL,
        gaps_json TEXT,
        stt_provider TEXT,
        transcript_json TEXT,
        voreo_status TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS capture_heartbeats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        capture_id TEXT NOT NULL,
        at TEXT NOT NULL,
        capturing INTEGER NOT NULL DEFAULT 0,
        in_call INTEGER NOT NULL DEFAULT 0,
        mic_active INTEGER NOT NULL DEFAULT 0,
        remote_tracks INTEGER NOT NULL DEFAULT 0,
        bytes_sent INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_links_space_name ON links (space_name);
      CREATE INDEX IF NOT EXISTS idx_links_meeting_code ON links (meeting_code);
      CREATE INDEX IF NOT EXISTS idx_voreo_queue_next ON voreo_queue (next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_event_queue_status_next ON event_queue (status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS capture_captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        capture_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_captures_status ON captures (status);
      CREATE INDEX IF NOT EXISTS idx_hb_capture ON capture_heartbeats (capture_id, at);
      CREATE INDEX IF NOT EXISTS idx_cc_capture ON capture_captions (capture_id, seq);

      -- ─── Recall.ai (tabelas novas, isoladas do que já existe) ───
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        bot_id TEXT UNIQUE,
        session_id TEXT,
        meeting_url TEXT NOT NULL,
        meeting_code TEXT,
        status TEXT NOT NULL,
        bot_name TEXT,
        started_at TEXT,
        ended_at TEXT,
        transcript_json TEXT,
        duration_seconds INTEGER,
        chatpro_status TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recall_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT UNIQUE,
        event TEXT NOT NULL,
        bot_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings (status);
      CREATE INDEX IF NOT EXISTS idx_meetings_session ON meetings (session_id);
      CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings (created_at);
      CREATE INDEX IF NOT EXISTS idx_recall_events_status_next ON recall_events (status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_recall_events_bot ON recall_events (bot_id);

      -- Conta Google de CADA atendente (a tabela google_tokens acima é de uma
      -- conta só, do servidor). Aqui cada instalação da extensão conecta a sua,
      -- e é com ela que o link do Meet é gerado — assim a reunião nasce na
      -- agenda de quem vai atender.
      CREATE TABLE IF NOT EXISTS google_accounts (
        device_id TEXT PRIMARY KEY,
        email TEXT,
        refresh_token_encrypted TEXT NOT NULL,
        access_token TEXT,
        expiry TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Colunas acrescentadas depois: o CREATE TABLE acima não roda em banco que
    // já existe, então quem já tinha a tabela precisa do ALTER.
    this.garantirColuna('meetings', 'chatpro_instance_id', 'TEXT');
    this.garantirColuna('meetings', 'chatpro_parts_sent', 'INTEGER NOT NULL DEFAULT 0');
    this.garantirColuna('meetings', 'transcript_texto', 'TEXT');

    // ─── Fluxo do time comercial ───
    // Quem marcou (e-mail lido do @chatpro:auth do localStorage) — é a chave
    // de atribuição no painel de reuniões.
    this.garantirColuna('meetings', 'atendente_email', 'TEXT');
    // apresentacao | migracao | implantacao | cs
    this.garantirColuna('meetings', 'tipo', 'TEXT');
    // Dados do cliente exigidos em implantação/CS/migração:
    // { nome, cnpj, instancia, telefone } — JSON pra não abrir 4 colunas que
    // ainda podem mudar quando a API interna chegar.
    this.garantirColuna('meetings', 'cliente_json', 'TEXT');
    // Palavras-chave detectadas na transcrição (sem IA): ["ia","oficial",…]
    this.garantirColuna('meetings', 'palavras_json', 'TEXT');

    // Mensagens que só podem sair PERTO do horário (reunião agendada convida o
    // cliente ~5 min antes, não na hora de marcar). Fila durável: reiniciar o
    // servidor não pode perder um convite marcado pra amanhã.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS envios_agendados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        instance_id TEXT,
        message TEXT NOT NULL,
        enviar_em TEXT NOT NULL,
        -- Quando a REUNIÃO começa (≠ enviar_em, que é ~5 min antes). É com este
        -- valor que "hoje/amanhã" é resolvido NA HORA DO ENVIO: a mensagem é
        -- montada hoje e entregue amanhã, então texto relativo congelado sai
        -- errado ("amanhã às 10h" chegando no próprio dia da reunião).
        reuniao_em TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_envios_status_quando
        ON envios_agendados (status, enviar_em);
    `);
    // O CREATE acima só vale pra banco novo; quem já rodou a versão anterior da
    // tabela precisa do ALTER pra ganhar a coluna.
    this.garantirColuna('envios_agendados', 'reuniao_em', 'TEXT');
    this.garantirIndiceDeBusca();
  }

  /**
   * Índice de texto (FTS5) sobre as falas das reuniões.
   *
   * É um índice EXTERNAL CONTENT: quem guarda o texto continua sendo a coluna
   * `meetings.transcript_texto`, o índice guarda só os termos. Quem mantém os
   * dois em dia são TRIGGERS no banco — de propósito. Reindexar do lado do
   * TypeScript dependeria de todo caminho de escrita lembrar de chamar a
   * reindexação; com trigger, qualquer UPDATE que toque a coluna já atualiza o
   * índice, venha de onde vier (inclusive de um `sqlite3` na mão).
   */
  private garantirIndiceDeBusca(): void {
    // Preenche o texto plano de quem já tinha transcrição gravada. Roda ANTES
    // de criar a tabela virtual porque é dela que o 'rebuild' lá embaixo lê.
    const pendentes = this.db
      .prepare<[], { id: string; transcript_json: string }>(
        `SELECT id, transcript_json FROM meetings
          WHERE transcript_json IS NOT NULL AND transcript_texto IS NULL`
      )
      .all();
    if (pendentes.length > 0) {
      const gravar = this.db.prepare('UPDATE meetings SET transcript_texto = ? WHERE id = ?');
      const emLote = this.db.transaction((linhas: typeof pendentes) => {
        for (const linha of linhas) gravar.run(textoDasFalas(linha.transcript_json), linha.id);
      });
      emLote(pendentes);
      log.info(`busca: ${pendentes.length} transcrição(ões) já gravadas preparadas pro índice.`);
    }

    const jaExistia =
      this.db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meetings_fts'`
        )
        .get() !== undefined;

    // remove_diacritics 2: "orçamento" tem que aparecer numa busca por
    // "orcamento" e vice-versa — ninguém digita acento em campo de busca.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
        transcript_texto,
        content = 'meetings',
        content_rowid = 'rowid',
        tokenize = "unicode61 remove_diacritics 2"
      );

      CREATE TRIGGER IF NOT EXISTS meetings_fts_ai AFTER INSERT ON meetings BEGIN
        INSERT INTO meetings_fts (rowid, transcript_texto)
        VALUES (new.rowid, new.transcript_texto);
      END;

      CREATE TRIGGER IF NOT EXISTS meetings_fts_ad AFTER DELETE ON meetings BEGIN
        INSERT INTO meetings_fts (meetings_fts, rowid, transcript_texto)
        VALUES ('delete', old.rowid, old.transcript_texto);
      END;

      CREATE TRIGGER IF NOT EXISTS meetings_fts_au
      AFTER UPDATE OF transcript_texto ON meetings BEGIN
        INSERT INTO meetings_fts (meetings_fts, rowid, transcript_texto)
        VALUES ('delete', old.rowid, old.transcript_texto);
        INSERT INTO meetings_fts (rowid, transcript_texto)
        VALUES (new.rowid, new.transcript_texto);
      END;
    `);

    // Só na criação: banco antigo (ou índice apagado na mão) entra populado.
    // Depois disso os triggers dão conta, e um rebuild a cada boot seria varrer
    // a tabela inteira à toa.
    if (!jaExistia) {
      this.db.exec(`INSERT INTO meetings_fts (meetings_fts) VALUES ('rebuild')`);
    }
  }

  /** ALTER TABLE idempotente — não faz nada se a coluna já existe. */
  private garantirColuna(tabela: string, coluna: string, definicao: string): void {
    const colunas = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(${tabela})`)
      .all()
      .map((c) => c.name);
    if (colunas.includes(coluna)) return;
    this.db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    log.info(`coluna ${tabela}.${coluna} criada.`);
  }

  // ─── links ────────────────────────────────────────────────────────────────

  upsertLink(input: {
    sessionId: string;
    meetingCode: string;
    spaceName: string | null;
    source: string;
  }): LinkRow {
    this.db
      .prepare(
        `INSERT INTO links (session_id, meeting_code, space_name, conference_record, linked_at, source)
         VALUES (@sessionId, @meetingCode, @spaceName, NULL, @linkedAt, @source)
         ON CONFLICT (session_id, meeting_code) DO UPDATE SET
           space_name = COALESCE(excluded.space_name, links.space_name),
           linked_at = excluded.linked_at,
           source = excluded.source`
      )
      .run({
        sessionId: input.sessionId,
        meetingCode: input.meetingCode,
        spaceName: input.spaceName,
        linkedAt: new Date().toISOString(),
        source: input.source,
      });
    const row = this.db
      .prepare<[string, string], LinkRow>(
        'SELECT * FROM links WHERE session_id = ? AND meeting_code = ?'
      )
      .get(input.sessionId, input.meetingCode);
    if (!row) throw new Error('Falha inesperada ao gravar vínculo.');
    return row;
  }

  listLinks(): LinkRow[] {
    return this.db.prepare<[], LinkRow>('SELECT * FROM links ORDER BY linked_at DESC').all();
  }

  findLinkBySpaceName(spaceName: string): LinkRow | undefined {
    return this.db
      .prepare<[string], LinkRow>(
        'SELECT * FROM links WHERE space_name = ? ORDER BY linked_at DESC LIMIT 1'
      )
      .get(spaceName);
  }

  findLinkByMeetingCode(meetingCode: string): LinkRow | undefined {
    return this.db
      .prepare<[string], LinkRow>(
        'SELECT * FROM links WHERE meeting_code = ? ORDER BY linked_at DESC LIMIT 1'
      )
      .get(meetingCode);
  }

  updateLinkSpace(id: number, spaceName: string): void {
    this.db.prepare('UPDATE links SET space_name = ? WHERE id = ?').run(spaceName, id);
  }

  updateLinkConferenceRecord(id: number, conferenceRecord: string): void {
    this.db
      .prepare('UPDATE links SET conference_record = ? WHERE id = ?')
      .run(conferenceRecord, id);
  }

  // ─── google_accounts (uma conta por instalação da extensão) ───────────────

  salvarContaGoogle(input: {
    deviceId: string;
    email: string | null;
    refreshTokenEncrypted: string;
    accessToken: string | null;
    expiry: string | null;
  }): void {
    const agora = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO google_accounts
           (device_id, email, refresh_token_encrypted, access_token, expiry, created_at, updated_at)
         VALUES (@deviceId, @email, @refreshTokenEncrypted, @accessToken, @expiry, @agora, @agora)
         ON CONFLICT (device_id) DO UPDATE SET
           email = COALESCE(excluded.email, google_accounts.email),
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           access_token = excluded.access_token,
           expiry = excluded.expiry,
           updated_at = excluded.updated_at`
      )
      .run({ ...input, agora });
  }

  buscarContaGoogle(deviceId: string): GoogleAccountRow | undefined {
    return this.db
      .prepare<[string], GoogleAccountRow>('SELECT * FROM google_accounts WHERE device_id = ?')
      .get(deviceId);
  }

  atualizarAccessTokenGoogle(deviceId: string, accessToken: string, expiry: string | null): void {
    this.db
      .prepare(
        'UPDATE google_accounts SET access_token = ?, expiry = ?, updated_at = ? WHERE device_id = ?'
      )
      .run(accessToken, expiry, new Date().toISOString(), deviceId);
  }

  removerContaGoogle(deviceId: string): void {
    this.db.prepare('DELETE FROM google_accounts WHERE device_id = ?').run(deviceId);
  }

  // ─── google_tokens ────────────────────────────────────────────────────────

  saveGoogleTokens(input: {
    refreshTokenEncrypted: string;
    accessToken: string | null;
    expiry: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO google_tokens (id, refresh_token_encrypted, access_token, expiry)
         VALUES (1, @refreshTokenEncrypted, @accessToken, @expiry)
         ON CONFLICT (id) DO UPDATE SET
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           access_token = excluded.access_token,
           expiry = excluded.expiry`
      )
      .run(input);
  }

  getGoogleTokens(): GoogleTokensRow | undefined {
    return this.db
      .prepare<[], GoogleTokensRow>('SELECT * FROM google_tokens WHERE id = 1')
      .get();
  }

  updateAccessToken(accessToken: string, expiry: string | null): void {
    this.db
      .prepare('UPDATE google_tokens SET access_token = ?, expiry = ? WHERE id = 1')
      .run(accessToken, expiry);
  }

  // ─── subscriptions ────────────────────────────────────────────────────────

  upsertSubscription(input: {
    name: string;
    targetResource: string;
    expireTime: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions (name, target_resource, expire_time)
         VALUES (@name, @targetResource, @expireTime)
         ON CONFLICT (name) DO UPDATE SET
           target_resource = excluded.target_resource,
           expire_time = excluded.expire_time`
      )
      .run(input);
  }

  deleteSubscription(name: string): void {
    this.db.prepare('DELETE FROM subscriptions WHERE name = ?').run(name);
  }

  listSubscriptionRows(): SubscriptionRow[] {
    return this.db.prepare<[], SubscriptionRow>('SELECT * FROM subscriptions').all();
  }

  // ─── transcripts_sent ─────────────────────────────────────────────────────

  hasTranscriptBeenSent(transcriptName: string): boolean {
    const row = this.db
      .prepare<[string], { id: number }>(
        'SELECT id FROM transcripts_sent WHERE transcript_name = ?'
      )
      .get(transcriptName);
    return row !== undefined;
  }

  recordTranscriptSent(input: {
    conferenceRecord: string;
    transcriptName: string;
    sessionId: string | null;
    status: string;
    payloadJson: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO transcripts_sent
           (conference_record, transcript_name, session_id, sent_to_voreo_at, voreo_status, payload_json)
         VALUES (@conferenceRecord, @transcriptName, @sessionId, NULL, @status, @payloadJson)
         ON CONFLICT (transcript_name) DO UPDATE SET
           voreo_status = excluded.voreo_status,
           session_id = COALESCE(excluded.session_id, transcripts_sent.session_id),
           payload_json = COALESCE(excluded.payload_json, transcripts_sent.payload_json)`
      )
      .run(input);
  }

  markTranscriptStatus(transcriptName: string, status: string, sentAt: string | null): void {
    this.db
      .prepare(
        'UPDATE transcripts_sent SET voreo_status = ?, sent_to_voreo_at = ? WHERE transcript_name = ?'
      )
      .run(status, sentAt, transcriptName);
  }

  getTranscriptSent(transcriptName: string): TranscriptSentRow | undefined {
    return this.db
      .prepare<[string], TranscriptSentRow>(
        'SELECT * FROM transcripts_sent WHERE transcript_name = ?'
      )
      .get(transcriptName);
  }

  // ─── voreo_queue ──────────────────────────────────────────────────────────

  enqueueVoreo(input: {
    payloadJson: string;
    attempts: number;
    nextAttemptAt: string | null;
    lastError: string | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO voreo_queue (payload_json, attempts, next_attempt_at, last_error)
         VALUES (@payloadJson, @attempts, @nextAttemptAt, @lastError)`
      )
      .run(input);
    return Number(result.lastInsertRowid);
  }

  dueVoreoItems(nowIso: string, limit: number): VoreoQueueRow[] {
    return this.db
      .prepare<[string, number], VoreoQueueRow>(
        `SELECT * FROM voreo_queue
         WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit);
  }

  recordVoreoAttempt(
    id: number,
    attempts: number,
    nextAttemptAt: string | null,
    lastError: string | null
  ): void {
    this.db
      .prepare(
        'UPDATE voreo_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?'
      )
      .run(attempts, nextAttemptAt, lastError, id);
  }

  removeVoreoItem(id: number): void {
    this.db.prepare('DELETE FROM voreo_queue WHERE id = ?').run(id);
  }

  getVoreoItem(id: number): VoreoQueueRow | undefined {
    return this.db
      .prepare<[number], VoreoQueueRow>('SELECT * FROM voreo_queue WHERE id = ?')
      .get(id);
  }

  countVoreoQueue(): { pending: number; dead: number } {
    const pending = this.db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM voreo_queue WHERE next_attempt_at IS NOT NULL'
      )
      .get();
    const dead = this.db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM voreo_queue WHERE next_attempt_at IS NULL'
      )
      .get();
    return { pending: pending?.n ?? 0, dead: dead?.n ?? 0 };
  }

  // ─── event_queue (fila durável de eventos do Pub/Sub) ─────────────────────

  /**
   * Enfileira um evento; deduplica contra eventos ativos (pending/no-link)
   * do mesmo ce_type + resource_name (Pub/Sub pode reentregar).
   */
  enqueueEvent(input: {
    ceType: string;
    resourceName: string;
    payloadJson: string | null;
    nextAttemptAt: string;
    createdAt: string;
  }): { id: number; created: boolean } {
    const existing = this.db
      .prepare<[string, string], { id: number }>(
        `SELECT id FROM event_queue
         WHERE ce_type = ? AND resource_name = ? AND status IN ('pending', 'no-link')`
      )
      .get(input.ceType, input.resourceName);
    if (existing) return { id: existing.id, created: false };

    const result = this.db
      .prepare(
        `INSERT INTO event_queue (ce_type, resource_name, payload_json, attempts, next_attempt_at, status, created_at)
         VALUES (@ceType, @resourceName, @payloadJson, 0, @nextAttemptAt, 'pending', @createdAt)`
      )
      .run(input);
    return { id: Number(result.lastInsertRowid), created: true };
  }

  dueEvents(nowIso: string, limit: number): EventQueueRow[] {
    return this.db
      .prepare<[string, number], EventQueueRow>(
        `SELECT * FROM event_queue
         WHERE status IN ('pending', 'no-link')
           AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit);
  }

  markEventDone(id: number): void {
    this.db
      .prepare(`UPDATE event_queue SET status = 'done', next_attempt_at = NULL, last_error = NULL WHERE id = ?`)
      .run(id);
  }

  markEventDead(id: number, lastError: string, attempts?: number): void {
    this.db
      .prepare(
        `UPDATE event_queue
         SET status = 'dead', next_attempt_at = NULL, last_error = ?, attempts = COALESCE(?, attempts)
         WHERE id = ?`
      )
      .run(lastError, attempts ?? null, id);
  }

  markEventNoLink(id: number, spaceName: string | null, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE event_queue
         SET status = 'no-link',
             space_name = COALESCE(?, space_name),
             next_attempt_at = ?,
             last_error = 'sem vínculo sessionId↔meet'
         WHERE id = ?`
      )
      .run(spaceName, nextAttemptAt, id);
  }

  /** Falha transitória: mantém pending com backoff. */
  recordEventFailure(id: number, attempts: number, nextAttemptAt: string, lastError: string): void {
    this.db
      .prepare(
        `UPDATE event_queue SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`
      )
      .run(attempts, nextAttemptAt, lastError, id);
  }

  /**
   * Reativa eventos no-link após um vínculo novo (reprocessamento imediato).
   * Com spaceName conhecido, reativa os daquele space + os de space desconhecido;
   * sem spaceName (spaces.get falhou), reativa todos os no-link.
   */
  reactivateNoLinkEvents(spaceName: string | null, nowIso: string): number {
    const result = this.db
      .prepare(
        `UPDATE event_queue
         SET status = 'pending', next_attempt_at = @nowIso, last_error = NULL
         WHERE status = 'no-link'
           AND (@spaceName IS NULL OR space_name = @spaceName OR space_name IS NULL)`
      )
      .run({ spaceName, nowIso });
    return result.changes;
  }

  countEventQueue(): { pending: number; noLink: number; dead: number; done: number } {
    const rows = this.db
      .prepare<[], { status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM event_queue GROUP BY status'
      )
      .all();
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
      pending: byStatus.get('pending') ?? 0,
      noLink: byStatus.get('no-link') ?? 0,
      dead: byStatus.get('dead') ?? 0,
      done: byStatus.get('done') ?? 0,
    };
  }

  getEvent(id: number): EventQueueRow | undefined {
    return this.db
      .prepare<[number], EventQueueRow>('SELECT * FROM event_queue WHERE id = ?')
      .get(id);
  }

  // ─── captures (captura de áudio + transcrição por STT) ────────────────────

  createCapture(input: {
    id: string;
    sessionId: string | null;
    meetingCode: string | null;
    mode: string;
    mimeType: string | null;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO captures (id, session_id, meeting_code, mode, mime_type, started_at, status)
         VALUES (@id, @sessionId, @meetingCode, @mode, @mimeType, @startedAt, 'recording')`
      )
      .run(input);
  }

  getCapture(id: string): CaptureRow | undefined {
    return this.db.prepare<[string], CaptureRow>('SELECT * FROM captures WHERE id = ?').get(id);
  }

  /**
   * Captura ABERTA (ainda gravando, sem fim) do mesmo meetingCode iniciada há
   * pouco. Serve pra DEDUPLICAR: legenda e áudio pedem /start separadamente e o
   * service worker do MV3 dorme entre uma e outra — sem isso, a reunião aparecia
   * DUPLICADA. Aqui os dois caem na mesma captura.
   */
  findOpenCaptureByMeetingCode(meetingCode: string, sinceIso: string): CaptureRow | undefined {
    return this.db
      .prepare<[string, string], CaptureRow>(
        `SELECT * FROM captures
         WHERE meeting_code = ? AND ended_at IS NULL AND started_at >= ?
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(meetingCode, sinceIso);
  }

  listCaptures(limit = 50): CaptureRow[] {
    return this.db
      .prepare<[number], CaptureRow>('SELECT * FROM captures ORDER BY started_at DESC LIMIT ?')
      .all(limit);
  }

  markCaptureStopped(input: { id: string; endedAt: string; stopReason: string }): void {
    this.db
      .prepare(
        `UPDATE captures SET ended_at = @endedAt, stop_reason = @stopReason, status = 'pending'
         WHERE id = @id AND status = 'recording'`
      )
      .run(input);
  }

  setCaptureStatus(id: string, status: CaptureStatus, error: string | null = null): void {
    this.db.prepare('UPDATE captures SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  }

  saveCaptureTranscript(input: {
    id: string;
    transcriptJson: string;
    coverageRatio: number;
    gapsJson: string;
    sttProvider: string;
    status: CaptureStatus;
  }): void {
    this.db
      .prepare(
        `UPDATE captures SET transcript_json = @transcriptJson, coverage_ratio = @coverageRatio,
           gaps_json = @gapsJson, stt_provider = @sttProvider, status = @status, error = NULL
         WHERE id = @id`
      )
      .run(input);
  }

  setCaptureVoreoStatus(id: string, voreoStatus: string): void {
    this.db.prepare('UPDATE captures SET voreo_status = ? WHERE id = ?').run(voreoStatus, id);
  }

  /**
   * Captures a retomar no boot: 'pending' (nunca começou) e 'transcribing'
   * (o servidor morreu no meio da transcrição — reprocessa do zero).
   */
  pendingCaptures(): CaptureRow[] {
    return this.db
      .prepare<[], CaptureRow>(
        `SELECT * FROM captures WHERE status IN ('pending', 'transcribing') ORDER BY started_at ASC`
      )
      .all();
  }

  countCaptures(): Record<string, number> {
    const rows = this.db
      .prepare<[], { status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM captures GROUP BY status'
      )
      .all();
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  addHeartbeat(input: {
    captureId: string;
    at: string;
    capturing: boolean;
    inCall: boolean;
    micActive: boolean;
    remoteTracks: number;
    bytesSent: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO capture_heartbeats
           (capture_id, at, capturing, in_call, mic_active, remote_tracks, bytes_sent)
         VALUES (@captureId, @at, @capturing, @inCall, @micActive, @remoteTracks, @bytesSent)`
      )
      .run({
        captureId: input.captureId,
        at: input.at,
        capturing: input.capturing ? 1 : 0,
        inCall: input.inCall ? 1 : 0,
        micActive: input.micActive ? 1 : 0,
        remoteTracks: input.remoteTracks,
        bytesSent: input.bytesSent,
      });
  }

  addCaption(input: {
    captureId: string;
    seq: number;
    speaker: string;
    text: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO capture_captions (capture_id, seq, speaker, text, at)
         VALUES (@captureId, @seq, @speaker, @text, @at)`
      )
      .run(input);
  }

  listCaptions(captureId: string): CaptionRow[] {
    return this.db
      .prepare<[string], CaptionRow>(
        'SELECT * FROM capture_captions WHERE capture_id = ? ORDER BY seq ASC'
      )
      .all(captureId);
  }

  countCaptions(captureId: string): number {
    const r = this.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM capture_captions WHERE capture_id = ?'
      )
      .get(captureId);
    return r?.n ?? 0;
  }

  listHeartbeats(captureId: string): CaptureHeartbeatRow[] {
    return this.db
      .prepare<[string], CaptureHeartbeatRow>(
        'SELECT * FROM capture_heartbeats WHERE capture_id = ? ORDER BY at ASC'
      )
      .all(captureId);
  }

  // ─── meetings (reuniões gravadas pelo bot do Recall.ai) ───────────────────

  createMeeting(input: {
    id: string;
    botId: string | null;
    sessionId: string | null;
    meetingUrl: string;
    meetingCode: string | null;
    botName: string | null;
    chatproInstanceId?: string | null;
    atendenteEmail?: string | null;
    tipo?: string | null;
    clienteJson?: string | null;
    status?: MeetingStatus;
    createdAt?: string;
  }): MeetingRow {
    this.db
      .prepare(
        `INSERT INTO meetings
           (id, bot_id, session_id, meeting_url, meeting_code, status, bot_name,
            chatpro_status, chatpro_instance_id, chatpro_parts_sent,
            atendente_email, tipo, cliente_json, created_at)
         VALUES (@id, @botId, @sessionId, @meetingUrl, @meetingCode, @status, @botName,
            'pending', @chatproInstanceId, 0,
            @atendenteEmail, @tipo, @clienteJson, @createdAt)`
      )
      .run({
        id: input.id,
        botId: input.botId,
        sessionId: input.sessionId,
        meetingUrl: input.meetingUrl,
        meetingCode: input.meetingCode,
        status: input.status ?? 'created',
        botName: input.botName,
        chatproInstanceId: input.chatproInstanceId ?? null,
        atendenteEmail: input.atendenteEmail ?? null,
        tipo: input.tipo ?? null,
        clienteJson: input.clienteJson ?? null,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
    const row = this.getMeeting(input.id);
    if (!row) throw new Error('Falha inesperada ao gravar a reunião.');
    return row;
  }

  getMeeting(id: string): MeetingRow | undefined {
    return this.db.prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE id = ?').get(id);
  }

  /** O webhook só conhece o bot_id — é por aqui que ele acha a reunião. */
  getMeetingByBotId(botId: string): MeetingRow | undefined {
    return this.db
      .prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE bot_id = ?')
      .get(botId);
  }

  /**
   * Reunião ainda EM ANDAMENTO com o mesmo código de Meet.
   *
   * Serve pra não colocar dois bots na mesma chamada: o chatPro pode repetir a
   * chamada (retry, timeout, duplo clique do atendente) e cada bot a mais é um
   * robô visível pro cliente e uma hora cobrada a mais.
   *
   * Só conta o que ainda está vivo — 'ended'/'done'/'failed' ficam de fora,
   * senão uma reunião de ontem impediria a de hoje. A janela de tempo é a
   * segunda rede: uma linha travada em 'created' não bloqueia pra sempre.
   */
  findActiveMeetingByCode(
    meetingCode: string,
    desdeIso: string,
    /**
     * Linhas SEM bot_id só bloqueiam se forem recentes. Uma reunião que ficou
     * presa em 'created' (o processo caiu entre gravar a linha e receber o id
     * do bot) travaria a mesma sala pelas 12 h inteiras — ninguém conseguiria
     * gravar de novo. Essa janela curta é o suficiente pra segurar o duplo
     * clique e o retry, que é pra isso que o dedup existe.
     */
    semBotDesdeIso: string = desdeIso
  ): MeetingRow | undefined {
    return this.db
      .prepare<[string, string, string], MeetingRow>(
        `SELECT * FROM meetings
          WHERE meeting_code = ?
            AND status IN ('created', 'joining', 'waiting_room', 'recording')
            AND created_at >= ?
            AND (bot_id IS NOT NULL OR created_at >= ?)
          ORDER BY created_at DESC
          LIMIT 1`
      )
      .get(meetingCode, desdeIso, semBotDesdeIso);
  }

  listMeetings(limit = 50): MeetingRow[] {
    return this.db
      .prepare<[number], MeetingRow>('SELECT * FROM meetings ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }

  /**
   * Muda o status e, de quebra, carimba os marcos temporais:
   * `started_at` na primeira vez que grava (COALESCE preserva o original) e
   * `ended_at` ao chegar num estado terminal. Idempotente — webhook reentregue
   * não reescreve o horário.
   */
  updateMeetingStatus(id: string, status: MeetingStatus, error: string | null = null): void {
    const terminal = status === 'ended' || status === 'done' || status === 'failed';
    this.db
      .prepare(
        `UPDATE meetings
         SET status = @status,
             error = @error,
             started_at = CASE WHEN @isRecording = 1 THEN COALESCE(started_at, @now) ELSE started_at END,
             ended_at   = CASE WHEN @isTerminal  = 1 THEN COALESCE(ended_at, @now)   ELSE ended_at   END
         WHERE id = @id`
      )
      .run({
        id,
        status,
        error,
        isRecording: status === 'recording' ? 1 : 0,
        isTerminal: terminal ? 1 : 0,
        now: new Date().toISOString(),
      });
  }

  /** Transcript normalizado (JSON) + duração. Não mexe no status. */
  setMeetingTranscript(input: {
    id: string;
    transcriptJson: string;
    durationSeconds: number | null;
  }): void {
    this.db
      .prepare(
        // Zera chatpro_parts_sent: transcrição nova = fatiamento novo. Manter o
        // contador antigo faria a entrega começar no meio de um texto que não
        // existe mais, e o começo da transcrição nunca chegaria na conversa.
        `UPDATE meetings
            SET transcript_json = @transcriptJson,
                transcript_texto = @transcriptTexto,
                duration_seconds = @durationSeconds,
                chatpro_parts_sent = 0
          WHERE id = @id`
      )
      // O texto plano sai do mesmo UPDATE do JSON: os dois nunca divergem, e o
      // trigger do FTS5 vê a mudança na mesma transação.
      .run({ ...input, transcriptTexto: textoDasFalas(input.transcriptJson) });
  }

  /**
   * Carimba o resultado da entrega. `partsSent` só AVANÇA (MAX): uma tentativa
   * que falhou logo no começo não pode apagar o que uma anterior já entregou —
   * senão o reenvio republicaria as partes que já estão na conversa.
   */
  setMeetingChatproStatus(id: string, chatproStatus: ChatproStatus, partsSent?: number): void {
    if (partsSent === undefined) {
      this.db.prepare('UPDATE meetings SET chatpro_status = ? WHERE id = ?').run(chatproStatus, id);
      return;
    }
    this.db
      .prepare(
        `UPDATE meetings
            SET chatpro_status = @status,
                chatpro_parts_sent = MAX(COALESCE(chatpro_parts_sent, 0), @parts)
          WHERE id = @id`
      )
      .run({ id, status: chatproStatus, parts: partsSent });
  }

  /** Palavras-chave detectadas na transcrição (uma vez por reunião). */
  setMeetingPalavras(id: string, palavras: string[]): void {
    this.db
      .prepare('UPDATE meetings SET palavras_json = ? WHERE id = ?')
      .run(JSON.stringify(palavras), id);
  }

  // ─── envios_agendados (convite que sai perto do horário) ──────────────────

  criarEnvioAgendado(input: {
    meetingId: string;
    sessionId: string;
    instanceId: string | null;
    message: string;
    enviarEm: string;
    reuniaoEm?: string | null;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO envios_agendados
           (meeting_id, session_id, instance_id, message, enviar_em, reuniao_em,
            status, attempts, created_at)
         VALUES (@meetingId, @sessionId, @instanceId, @message, @enviarEm, @reuniaoEm,
            'pendente', 0, @agora)`
      )
      .run({ ...input, reuniaoEm: input.reuniaoEm ?? null, agora: new Date().toISOString() });
    return Number(r.lastInsertRowid);
  }

  enviosVencidos(agoraIso: string, limite: number): EnvioAgendadoRow[] {
    return this.db
      .prepare<[string, number], EnvioAgendadoRow>(
        `SELECT * FROM envios_agendados
          WHERE status = 'pendente' AND enviar_em <= ?
          ORDER BY enviar_em ASC LIMIT ?`
      )
      .all(agoraIso, limite);
  }

  marcarEnvio(id: number, status: 'enviado' | 'falhou', erro?: string): void {
    this.db
      .prepare(
        `UPDATE envios_agendados
            SET status = @status, attempts = attempts + 1, last_error = @erro
          WHERE id = @id`
      )
      .run({ id, status, erro: erro ?? null });
  }

  /** Reunião agendada cancelada leva os convites pendentes junto. */
  cancelarEnviosDaReuniao(meetingId: string): number {
    const r = this.db
      .prepare(
        `UPDATE envios_agendados SET status = 'cancelado'
          WHERE meeting_id = ? AND status = 'pendente'`
      )
      .run(meetingId);
    return r.changes;
  }

  /** Instância do chatPro da conversa (descoberta pelo webhook). */
  setMeetingChatproInstance(id: string, instanceId: string): void {
    this.db.prepare('UPDATE meetings SET chatpro_instance_id = ? WHERE id = ?').run(instanceId, id);
  }

  /**
   * Amarra o bot à reunião. A linha nasce com bot_id NULL (gravada antes de
   * chamar o Recall), e o id chega ou pela resposta do createBot ou pelo
   * primeiro webhook, quando aquela resposta se perdeu no timeout.
   */
  setMeetingBotId(id: string, botId: string): void {
    this.db.prepare('UPDATE meetings SET bot_id = ? WHERE id = ?').run(botId, id);
  }

  /** O vínculo com o chatPro pode chegar depois da criação do bot. */
  setMeetingSessionId(id: string, sessionId: string): void {
    this.db.prepare('UPDATE meetings SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  countMeetings(): Record<string, number> {
    const rows = this.db
      .prepare<[], { status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM meetings GROUP BY status'
      )
      .all();
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.n;
    return out;
  }

  // ─── busca nas transcrições ───────────────────────────────────────────────

  /**
   * Procura um termo dentro das falas das reuniões já transcritas.
   *
   * Devolve UMA linha por reunião (o índice guarda a conversa inteira numa
   * linha só), ordenada por relevância — bm25 é negativo, então quanto menor,
   * melhor o casamento. O `trecho` vem do `snippet()` do próprio FTS5, com o
   * termo entre colchetes e algumas palavras de contexto em volta.
   *
   * Nada do que sai daqui pode ir pro log: é conteúdo de conversa de cliente.
   */
  buscarNasTranscricoes(termo: string, limite: number): ResultadoBusca[] {
    const consulta = montarConsultaFts(termo);
    if (consulta === '' || !Number.isFinite(limite) || limite < 1) return [];
    return this.db
      .prepare<[string, number], ResultadoBusca>(
        `SELECT m.id AS meetingId,
                m.session_id AS sessionId,
                m.meeting_code AS meetingCode,
                COALESCE(m.started_at, m.created_at) AS quando,
                snippet(meetings_fts, 0, '[', ']', '…', ${PALAVRAS_NO_TRECHO}) AS trecho
           FROM meetings_fts
           JOIN meetings m ON m.rowid = meetings_fts.rowid
          WHERE meetings_fts MATCH ?
          ORDER BY bm25(meetings_fts)
          LIMIT ?`
      )
      .all(consulta, Math.floor(limite));
  }

  // ─── recall_events (fila durável dos webhooks do Recall) ──────────────────

  /**
   * Enfileira um webhook. O Recall retenta por 24 h, então reentrega é
   * ESPERADA: o `webhook_id` (header `webhook-id` do Svix) é UNIQUE e a
   * segunda chegada devolve `{ created: false }` sem gerar trabalho novo.
   * Sem webhook_id (modo inseguro de dev), cada chamada vira um item.
   */
  enqueueRecallEvent(input: {
    webhookId: string | null;
    event: string;
    botId: string | null;
    payloadJson: string;
    nextAttemptAt: string;
    createdAt: string;
  }): { id: number; created: boolean } {
    const result = this.db
      .prepare(
        `INSERT INTO recall_events
           (webhook_id, event, bot_id, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (@webhookId, @event, @botId, @payloadJson, 'pending', 0, @nextAttemptAt, @createdAt)
         ON CONFLICT (webhook_id) DO NOTHING`
      )
      .run(input);

    if (result.changes > 0) return { id: Number(result.lastInsertRowid), created: true };

    const existing = input.webhookId
      ? this.db
          .prepare<[string], { id: number }>('SELECT id FROM recall_events WHERE webhook_id = ?')
          .get(input.webhookId)
      : undefined;
    if (!existing) throw new Error('Falha inesperada ao enfileirar evento do Recall.');
    return { id: existing.id, created: false };
  }

  dueRecallEvents(nowIso: string, limit: number): RecallEventRow[] {
    return this.db
      .prepare<[string, number], RecallEventRow>(
        `SELECT * FROM recall_events
         WHERE status = 'pending'
           AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit);
  }

  markRecallEventDone(id: number): void {
    this.db
      .prepare(
        `UPDATE recall_events SET status = 'done', next_attempt_at = NULL, last_error = NULL WHERE id = ?`
      )
      .run(id);
  }

  markRecallEventDead(id: number, lastError: string, attempts?: number): void {
    this.db
      .prepare(
        `UPDATE recall_events
         SET status = 'dead', next_attempt_at = NULL, last_error = ?, attempts = COALESCE(?, attempts)
         WHERE id = ?`
      )
      .run(lastError, attempts ?? null, id);
  }

  /** Falha transitória: segue pending, com backoff. */
  recordRecallEventFailure(
    id: number,
    attempts: number,
    nextAttemptAt: string,
    lastError: string
  ): void {
    this.db
      .prepare(
        `UPDATE recall_events SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`
      )
      .run(attempts, nextAttemptAt, lastError, id);
  }

  getRecallEvent(id: number): RecallEventRow | undefined {
    return this.db
      .prepare<[number], RecallEventRow>('SELECT * FROM recall_events WHERE id = ?')
      .get(id);
  }

  countRecallEvents(): { pending: number; done: number; dead: number } {
    const rows = this.db
      .prepare<[], { status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM recall_events GROUP BY status'
      )
      .all();
    const byStatus = new Map(rows.map((row) => [row.status, row.n]));
    return {
      pending: byStatus.get('pending') ?? 0,
      done: byStatus.get('done') ?? 0,
      dead: byStatus.get('dead') ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}
