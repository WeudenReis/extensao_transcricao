/**
 * Contrato provider-agnóstico de Speech-to-Text.
 *
 * Trocar de provedor (Deepgram, AssemblyAI, Whisper local…) é só mudar a env
 * STT_PROVIDER. Nenhum outro arquivo precisa saber qual está em uso.
 */

export interface SttEntry {
  /** Rótulo do falante ("Atendente", "Cliente", "Falante 1"…). */
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface SttResult {
  entries: SttEntry[];
  /** Resposta crua do provedor (guardada só para depuração, nunca logada). */
  raw?: unknown;
}

export interface SttInput {
  filePath: string;
  languageCode: string;
  /** Pede separação de falantes (usado na trilha remota com vários participantes). */
  diarize: boolean;
}

export interface SttProvider {
  readonly name: string;
  transcribe(input: SttInput): Promise<SttResult>;
  /** Opcional: pré-carrega o modelo no boot (evita travar na 1ª transcrição). */
  warmup?(): Promise<void>;
}
