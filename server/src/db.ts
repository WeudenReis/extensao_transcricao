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

      CREATE INDEX IF NOT EXISTS idx_links_space_name ON links (space_name);
      CREATE INDEX IF NOT EXISTS idx_links_meeting_code ON links (meeting_code);
      CREATE INDEX IF NOT EXISTS idx_voreo_queue_next ON voreo_queue (next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_event_queue_status_next ON event_queue (status, next_attempt_at);
    `);
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

  close(): void {
    this.db.close();
  }
}
