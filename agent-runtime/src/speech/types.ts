import type { AudioFrame } from "../media/types.js"

export type SpeechCapability = "stt" | "tts" | "realtime_voice"

export interface SttSessionOptions {
  /** Provider-defined session options; no room or participant capabilities. */
  [key: string]: unknown
}

export interface SttError {
  code: string
  message: string
  retryable?: boolean
}

export type SttEvent =
  | { type: "speech_started"; timestampMs?: number }
  | { type: "partial"; text: string; timestampMs?: number }
  | { type: "committed"; text: string; timestampMs?: number }
  | { type: "speech_ended"; timestampMs?: number }
  | { type: "error"; error: SttError }

export interface StreamingSttSession {
  pushAudio(frame: AudioFrame): Promise<void>
  events(): AsyncIterable<SttEvent>
  close(): Promise<void>
}

export interface StreamingSttProvider {
  createSession(options?: SttSessionOptions): Promise<StreamingSttSession>
}

export interface SpeechSetupField {
  key: string
  label: string
  secret: boolean
  required?: boolean
  environmentVariable?: string
}

export interface ProviderValidation {
  valid: boolean
  message?: string
}

export interface ProviderDiagnostic {
  ready: boolean
  message?: string
}

export interface SpeechProviderDescriptor {
  id: string
  name: string
  capabilities: readonly SpeechCapability[]
  setupFields: readonly SpeechSetupField[]
  validate(values: Record<string, string>): Promise<ProviderValidation>
  diagnose(values: Record<string, string>): Promise<ProviderDiagnostic>
  createSttProvider?: (values: Record<string, string>) => StreamingSttProvider
}

export interface SpeechProviderRegistry {
  get(id: string): SpeechProviderDescriptor | undefined
  list(): readonly SpeechProviderDescriptor[]
}
