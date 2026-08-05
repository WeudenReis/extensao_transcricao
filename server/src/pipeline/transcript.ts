import type { Db, LinkRow } from '../db.js';
import type { MeetApi, MeetParticipant, TranscriptEntry } from '../google/meet.js';
import { normalizeMeetingCode } from '../google/meet.js';
import type { VoreoClient, VoreoPayload } from '../voreo/client.js';
import { createLogger, errorMessage } from '../log.js';

/**
 * Pipeline principal: do evento `transcript.v2.fileGenerated` até o payload
 * pronto pra Voreo.
 *
 * 1. transcript name → conferenceRecord → space
 * 2. resolve o vínculo sessionId↔meet (por space_name ou meeting_code)
 * 3. busca entries paginadas + participantes (displayName)
 * 4. monta payload e entrega via VoreoClient (fila com retry)
 */

const log = createLogger('pipeline');

// ─── Funções puras (testáveis) ───────────────────────────────────────────────

/** "conferenceRecords/X/transcripts/Y" → "conferenceRecords/X" */
export function conferenceRecordFromTranscriptName(transcriptName: string): string {
  const idx = transcriptName.indexOf('/transcripts/');
  if (idx <= 0) {
    throw new Error(`Nome de transcript inesperado: ${transcriptName}`);
  }
  return transcriptName.slice(0, idx);
}

/** Mapa participant resource name → displayName (signed-in, anônimo ou telefone). */
export function buildParticipantNameMap(participants: MeetParticipant[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const participant of participants) {
    const displayName =
      participant.signedinUser?.displayName ??
      participant.anonymousUser?.displayName ??
      participant.phoneUser?.displayName;
    if (participant.name && displayName) {
      map.set(participant.name, displayName);
    }
  }
  return map;
}

export interface AssembledEntry {
  speaker: string;
  text: string;
  startTime: string | undefined;
  endTime: string | undefined;
}

/**
 * Monta o transcript final: resolve participant → displayName quando possível;
 * senão mantém o resource name (melhor que perder a autoria).
 */
export function assembleTranscript(
  entries: TranscriptEntry[],
  participantNames: Map<string, string>
): AssembledEntry[] {
  return entries.map((entry) => {
    const resolved = entry.participant ? participantNames.get(entry.participant) : undefined;
    return {
      speaker: resolved ?? entry.participant ?? 'desconhecido',
      text: entry.text ?? '',
      startTime: entry.startTime,
      endTime: entry.endTime,
    };
  });
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export interface TranscriptPipelineDeps {
  db: Db;
  meet: MeetApi;
  voreo: VoreoClient;
}

/**
 * Resultado de um processamento, consumido pela fila durável de eventos:
 * - done    → evento concluído (ou já processado antes)
 * - no-link → sem vínculo sessionId↔meet; fica na fila e retenta quando o vínculo chegar
 * - retry   → condição transitória (ex.: transcript ainda não gerado) — backoff
 * Erros transitórios (Meet API 500/429, rede) são LANÇADOS e viram retry no worker.
 */
export type PipelineOutcome =
  | { outcome: 'done' }
  | { outcome: 'no-link'; spaceName: string }
  | { outcome: 'retry'; reason: string };

export class TranscriptPipeline {
  constructor(private readonly deps: TranscriptPipelineDeps) {}

  /**
   * Resolve o vínculo sessionId↔meet para um space:
   * 1º por space_name direto; 2º por meeting_code (via spaces.get) — e nesse
   * caso persiste o space_name no vínculo pra próxima vez ser O(1).
   */
  async resolveLink(spaceName: string): Promise<LinkRow | undefined> {
    const bySpace = this.deps.db.findLinkBySpaceName(spaceName);
    if (bySpace) return bySpace;

    let meetingCode: string | undefined;
    try {
      const space = await this.deps.meet.getSpace(spaceName);
      meetingCode = space.meetingCode ? normalizeMeetingCode(space.meetingCode) : undefined;
    } catch (err) {
      log.warn(`spaces.get(${spaceName}) falhou ao resolver vínculo: ${errorMessage(err)}`);
      return undefined;
    }
    if (!meetingCode) return undefined;

    const byCode = this.deps.db.findLinkByMeetingCode(meetingCode);
    if (!byCode) return undefined;

    this.deps.db.updateLinkSpace(byCode.id, spaceName);
    return { ...byCode, space_name: spaceName };
  }

  async handleTranscriptFileGenerated(transcriptName: string): Promise<PipelineOutcome> {
    const { db, meet, voreo } = this.deps;

    const already = db.getTranscriptSent(transcriptName);
    if (already && already.voreo_status !== 'no-link') {
      log.info(`transcript ${transcriptName} já processado (${already.voreo_status}) — ignorando.`);
      return { outcome: 'done' };
    }

    const conferenceRecordName = conferenceRecordFromTranscriptName(transcriptName);
    const record = await meet.getConferenceRecord(conferenceRecordName);
    const spaceName = record.space;
    if (!spaceName) {
      log.warn(`conferenceRecord ${conferenceRecordName} sem space — não dá pra vincular.`);
      return { outcome: 'retry', reason: 'conferenceRecord sem space' };
    }

    const link = await this.resolveLink(spaceName);
    if (!link) {
      log.warn(
        `nenhum vínculo sessionId↔meet para ${spaceName} (${conferenceRecordName}) — ` +
          'evento fica no-link na fila e será reprocessado quando o vínculo chegar.'
      );
      db.recordTranscriptSent({
        conferenceRecord: conferenceRecordName,
        transcriptName,
        sessionId: null,
        status: 'no-link',
        payloadJson: null,
      });
      return { outcome: 'no-link', spaceName };
    }
    if (link.conference_record !== conferenceRecordName) {
      db.updateLinkConferenceRecord(link.id, conferenceRecordName);
    }

    const transcript = await meet.getTranscript(transcriptName);
    const entries = await meet.listAllTranscriptEntries(transcriptName);

    let participants: MeetParticipant[] = [];
    try {
      participants = await meet.listAllParticipants(conferenceRecordName);
    } catch (err) {
      log.warn(
        `participants.list(${conferenceRecordName}) falhou — mantendo resource names: ${errorMessage(err)}`
      );
    }

    const nameMap = buildParticipantNameMap(participants);
    const assembled = assembleTranscript(entries, nameMap);

    const participantNames =
      nameMap.size > 0
        ? [...new Set(nameMap.values())]
        : [...new Set(assembled.map((entry) => entry.speaker))];

    const payload: VoreoPayload = {
      sessionId: link.session_id,
      meetingCode: link.meeting_code,
      conferenceRecord: conferenceRecordName,
      startTime: record.startTime,
      endTime: record.endTime,
      participants: participantNames.map((name) => ({ name })),
      transcript: assembled,
      docsExportUri: transcript.docsDestination?.exportUri,
      source: 'chatpro-meet-extension',
    };

    log.info(
      `transcript ${transcriptName}: ${entries.length} entries, ` +
        `${participantNames.length} participantes, sessão ${link.session_id} — enviando à Voreo.`
    );

    db.recordTranscriptSent({
      conferenceRecord: conferenceRecordName,
      transcriptName,
      sessionId: link.session_id,
      status: 'queued',
      payloadJson: JSON.stringify(payload),
    });

    await voreo.deliver({ transcriptName, payload });
    return { outcome: 'done' };
  }

  /**
   * Fallback do `conference.v2.ended`: lista os transcripts da conferência e
   * processa os que ainda não foram (caso o fileGenerated não tenha chegado).
   * Sem transcripts ainda → 'retry' (o arquivo pode levar minutos pra sair).
   */
  async handleConferenceEnded(conferenceRecordName: string): Promise<PipelineOutcome> {
    const transcripts = await this.deps.meet.listTranscripts(conferenceRecordName);
    if (transcripts.length === 0) {
      log.info(`conferência ${conferenceRecordName} ainda sem transcripts — retentando depois.`);
      return { outcome: 'retry', reason: 'conferência ainda sem transcripts' };
    }
    let noLink: PipelineOutcome | undefined;
    for (const transcript of transcripts) {
      if (!transcript.name) continue;
      const result = await this.handleTranscriptFileGenerated(transcript.name);
      if (result.outcome === 'no-link') noLink = result;
      if (result.outcome === 'retry') return result;
    }
    return noLink ?? { outcome: 'done' };
  }
}
