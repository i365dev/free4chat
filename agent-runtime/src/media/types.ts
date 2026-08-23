/**
 * MediaBridge Phase 0 (#82): a resident Agent's SFU audio-ingress
 * capability. Subscribe-only — an Agent never publishes audio in this
 * phase. Raw audio remains transient; optional Runtime-owned STT may produce
 * a bounded local transcript outside the Worker/DO; see sfuMediaBridge.ts.
 */

export interface RoomAudioTrack {
  participantId: string
  participantName: string
  sessionId: string
  trackName: string
}

export interface AudioTrackStarted {
  type: "audioTrackStarted"
  participantId: string
  participantName: string
  trackName: string
}

/** Bounded, periodic diagnostics — never raw samples, never persisted. */
export interface AudioFrameStats {
  type: "audioFrameStats"
  participantId: string
  trackName: string
  frameCount: number
  byteCount: number
  /** Approximate, derived from RTP timestamp deltas — not a codec guarantee. */
  approxFrameDurationMs: number
  /** Only present when the payload could be decoded to PCM (see decoder.ts). */
  rms?: number
  hasSignal?: boolean
}

export interface AudioTrackEnded {
  type: "audioTrackEnded"
  participantId: string
  trackName: string
  reason: "participant_left" | "track_unpublished" | "bridge_stopped"
}

export type MediaBridgeEvent =
  AudioTrackStarted | AudioFrameStats | AudioTrackEnded

export type MediaBridgeEventHandler = (event: MediaBridgeEvent) => void

/** Runtime-owned attribution that stays outside provider-specific speech code. */
export interface AudioSource {
  participantId: string
  participantName: string
  trackName: string
}

/** Canonical raw audio boundary. No decoding or resampling is implied. */
export interface AudioFrame {
  codec: "opus" | "pcm_s16le"
  sampleRateHz: number
  channels: number
  timestampMs: number
  data: Uint8Array
}

export type AudioFrameHandler = (source: AudioSource, frame: AudioFrame) => void
