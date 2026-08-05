import { createLogger } from '../log.js';

/**
 * Client tipado da Google Meet REST API v2 (https://meet.googleapis.com/v2).
 *
 * Implementado com fetch nativo + tokens do google-auth-library — sem o pacote
 * `googleapis` (justificativa no README: os endpoints usados são poucos e
 * simples, e assim controlamos 100% dos tipos, sem 100 MB de dependência).
 */

const log = createLogger('google/meet');

export const MEET_API_BASE_URL = 'https://meet.googleapis.com/v2';

// ─── Tipos dos recursos ──────────────────────────────────────────────────────

export interface SpaceConfig {
  accessType?: string;
  artifactConfig?: {
    transcriptionConfig?: {
      autoTranscriptionGeneration?: 'ON' | 'OFF';
    };
  };
}

export interface MeetSpace {
  name?: string;
  meetingUri?: string;
  meetingCode?: string;
  config?: SpaceConfig;
}

export interface ConferenceRecord {
  name?: string;
  space?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

export interface Transcript {
  name?: string;
  state?: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: {
    document?: string;
    exportUri?: string;
  };
}

export interface TranscriptEntry {
  name?: string;
  /** Resource name: conferenceRecords/{cr}/participants/{p} */
  participant?: string;
  text?: string;
  startTime?: string;
  endTime?: string;
  languageCode?: string;
}

export interface MeetParticipant {
  name?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
  earliestStartTime?: string;
  latestEndTime?: string;
}

// ─── Interface (para stubs em teste) ─────────────────────────────────────────

export interface MeetApi {
  getSpaceByMeetingCode(meetingCode: string): Promise<MeetSpace>;
  getSpace(spaceName: string): Promise<MeetSpace>;
  createSpaceWithTranscription(): Promise<MeetSpace>;
  patchSpaceTranscription(spaceName: string): Promise<MeetSpace>;
  getConferenceRecord(name: string): Promise<ConferenceRecord>;
  listConferenceRecordsBySpace(spaceName: string): Promise<ConferenceRecord[]>;
  listTranscripts(conferenceRecordName: string): Promise<Transcript[]>;
  getTranscript(transcriptName: string): Promise<Transcript>;
  listAllTranscriptEntries(transcriptName: string): Promise<TranscriptEntry[]>;
  listAllParticipants(conferenceRecordName: string): Promise<MeetParticipant[]>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normaliza um meeting code: aceita "abc-defg-hij", URL completa do Meet
 * (https://meet.google.com/abc-defg-hij?authuser=0) e variações com maiúsculas.
 */
export function normalizeMeetingCode(input: string): string {
  let code = input.trim();
  const urlMatch = /meet\.google\.com\/([A-Za-z0-9-]+)/.exec(code);
  const fromUrl = urlMatch?.[1];
  if (fromUrl) code = fromUrl;
  code = code.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return code.toLowerCase();
}

export class MeetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'MeetApiError';
  }
}

export interface MeetClientOptions {
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class MeetClient implements MeetApi {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: MeetClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? MEET_API_BASE_URL;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { body?: unknown; query?: Record<string, string> } = {}
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new MeetApiError(
        `Meet API ${method} ${path} respondeu HTTP ${response.status}`,
        response.status,
        body
      );
    }
    return (await response.json()) as T;
  }

  // spaces.get aceita spaces/{meetingCode} — converte o código da URL em space.
  async getSpaceByMeetingCode(meetingCode: string): Promise<MeetSpace> {
    return this.request<MeetSpace>('GET', `spaces/${normalizeMeetingCode(meetingCode)}`);
  }

  async getSpace(spaceName: string): Promise<MeetSpace> {
    return this.request<MeetSpace>('GET', spaceName);
  }

  async createSpaceWithTranscription(): Promise<MeetSpace> {
    return this.request<MeetSpace>('POST', 'spaces', {
      body: {
        config: {
          artifactConfig: {
            transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
          },
        },
      },
    });
  }

  async patchSpaceTranscription(spaceName: string): Promise<MeetSpace> {
    return this.request<MeetSpace>('PATCH', spaceName, {
      query: {
        updateMask: 'config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration',
      },
      body: {
        config: {
          artifactConfig: {
            transcriptionConfig: { autoTranscriptionGeneration: 'ON' },
          },
        },
      },
    });
  }

  async getConferenceRecord(name: string): Promise<ConferenceRecord> {
    return this.request<ConferenceRecord>('GET', name);
  }

  async listConferenceRecordsBySpace(spaceName: string): Promise<ConferenceRecord[]> {
    const records: ConferenceRecord[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { filter: `space.name="${spaceName}"` };
      if (pageToken) query.pageToken = pageToken;
      const page = await this.request<{
        conferenceRecords?: ConferenceRecord[];
        nextPageToken?: string;
      }>('GET', 'conferenceRecords', { query });
      if (page.conferenceRecords) records.push(...page.conferenceRecords);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return records;
  }

  async listTranscripts(conferenceRecordName: string): Promise<Transcript[]> {
    const transcripts: Transcript[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {};
      if (pageToken) query.pageToken = pageToken;
      const page = await this.request<{ transcripts?: Transcript[]; nextPageToken?: string }>(
        'GET',
        `${conferenceRecordName}/transcripts`,
        { query }
      );
      if (page.transcripts) transcripts.push(...page.transcripts);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return transcripts;
  }

  async getTranscript(transcriptName: string): Promise<Transcript> {
    return this.request<Transcript>('GET', transcriptName);
  }

  /** Busca TODAS as entries do transcript (pageSize máx 100, paginação completa). */
  async listAllTranscriptEntries(transcriptName: string): Promise<TranscriptEntry[]> {
    const entries: TranscriptEntry[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { pageSize: '100' };
      if (pageToken) query.pageToken = pageToken;
      const page = await this.request<{ entries?: TranscriptEntry[]; nextPageToken?: string }>(
        'GET',
        `${transcriptName}/entries`,
        { query }
      );
      if (page.entries) entries.push(...page.entries);
      pageToken = page.nextPageToken;
    } while (pageToken);
    log.debug(`${transcriptName}: ${entries.length} entries carregadas.`);
    return entries;
  }

  async listAllParticipants(conferenceRecordName: string): Promise<MeetParticipant[]> {
    const participants: MeetParticipant[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { pageSize: '100' };
      if (pageToken) query.pageToken = pageToken;
      const page = await this.request<{
        participants?: MeetParticipant[];
        nextPageToken?: string;
      }>('GET', `${conferenceRecordName}/participants`, { query });
      if (page.participants) participants.push(...page.participants);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return participants;
  }
}
