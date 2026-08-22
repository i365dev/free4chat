/**
 * MediaBridge Phase 0 (#82): a resident Agent's SFU audio-ingress
 * capability. Subscribe-only — an Agent never publishes audio in this
 * phase. No STT, no persistence, no cloud upload; see sfuMediaBridge.ts.
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
