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

/** One synthesized audio block, ordered within a synthesis round. Raw PCM
 * keeps the Runtime free of codec dependencies; providers that only emit
 * compressed audio must decode before crossing this boundary. */
export interface TtsAudioChunk {
  codec: "pcm_s16le"
  sampleRateHz: number
  channels: number
  data: Uint8Array
}

export interface TtsError {
  code: string
  message: string
  retryable?: boolean
}

export interface TtsSynthesisOptions {
  /** Provider-defined session options; no room or participant capabilities. */
  [key: string]: unknown
}

/**
 * One speakable unit for a resident Agent's outbound voice (#83 vertical
 * slice). A session serves sequential synthesis rounds: each `synthesize`
 * call receives one coherent text chunk and its iterable must fully drain
 * (or be abandoned via close) before the next round starts. Implementations
 * signal failure by throwing; the message must never contain credentials.
 */
export interface StreamingTtsSession {
  synthesize(
    text: string,
    options?: TtsSynthesisOptions
  ): AsyncIterable<TtsAudioChunk>
  close(): Promise<void>
}

export interface StreamingTtsProvider {
  createSession(options?: TtsSynthesisOptions): Promise<StreamingTtsSession>
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
  createTtsProvider?: (values: Record<string, string>) => StreamingTtsProvider
}

export interface SpeechProviderRegistry {
  get(id: string): SpeechProviderDescriptor | undefined
  list(): readonly SpeechProviderDescriptor[]
}
