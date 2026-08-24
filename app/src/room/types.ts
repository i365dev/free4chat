export type ParticipantKind = "human" | "agent"

export type RoomMediaTrackKind = "audio" | "video"

export interface RoomMediaTrack {
  trackName: string
  kind: RoomMediaTrackKind
  mid?: string
}

export interface RoomMediaState {
  sessionId: string
  muted: boolean
  fileChannelReady: boolean
  tracks: RoomMediaTrack[]
  // Cloudflare-assigned `mid`s for an agent's active *remote* (subscribe)
  // track negotiations on this sessionId — never set for a human. Exists
  // solely so the DO can actively close these tracks server-side when the
  // Meeting Notes grant naming this agent is revoked (Stop, reassignment,
  // leave, lease expiry): flipping room state alone does not stop RTP
  // already flowing over an established PeerConnection. Stripped out of
  // every human-facing broadcast (see RoomSession.stateFor) — it is
  // Cloudflare session bookkeeping, not participant-visible state.
  agentSubscribedMids?: string[]
}

export interface AgentCapabilities {
  text: true
}

export interface RoomParticipant {
  id: string
  name: string
  kind: ParticipantKind
  connected: boolean
  joinedAt: number
  lastSeenAt: number
  connectionNonce?: string
  token: string
  capabilities?: AgentCapabilities
  media?: RoomMediaState
}

export interface RoomMessage {
  id: string
  peerId: string
  name: string
  kind: ParticipantKind
  type: "text" | "action"
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  targets?: string[]
  createdAt: number
  sequence: number
}

export type AgentImageMimeType = "image/jpeg" | "image/png" | "image/webp"
export type AgentTextMimeType =
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json"
export type AgentAttachmentMimeType = AgentImageMimeType | AgentTextMimeType

export interface RoomAttachment {
  id: string
  senderId: string
  senderName: string
  mimeType: AgentAttachmentMimeType
  fileName: string
  size: number
  chunkCount: number
  createdAt: number
  sequence: number
}

// Room-scoped Meeting Notes media-listening grant (#82). Visible to every
// participant via room state — never a capability secret. `active: false`
// is the only state that carries no `agentParticipantId`/`startedAt`;
// deliberately mirrors the shape of "no grant" so a room that was never
// started, and a room that was started then stopped, look identical.
export interface MeetingNotesState {
  active: boolean
  agentParticipantId?: string
  startedAt?: number
}

export interface RoomState {
  createdAt: number
  expiresAt: number
  participants: Array<Omit<RoomParticipant, "token" | "connectionNonce">>
  messages: RoomMessage[]
  meetingNotes: MeetingNotesState
  // Whether the server-side Meeting Notes media capability (the
  // AGENT_MEDIA_ENABLED master switch) is on in this environment at all —
  // independent of whether any grant is currently active. The client must
  // never offer Start, and must never claim "Listening", when this is
  // false: every actual Runtime media request would 403 regardless of the
  // room-visible grant.
  meetingNotesMediaAvailable: boolean
}

// A Cloudflare Realtime track-close attempt that hasn't been confirmed
// successful yet (a non-2xx response, missing credentials, or a network
// failure) — retained so RoomSession's alarm can retry it, rather than
// silently losing track of media that must still be revoked. Server-only:
// never part of RoomState (see realtimeMedia.ts).
export interface PendingMediaCleanup {
  sessionId: string
  mids: string[]
}

export interface RoomRecord {
  createdAt: number
  expiresAt: number
  participants: Record<string, RoomParticipant>
  messages: RoomMessage[]
  attachments: RoomAttachment[]
  nextMessageSequence: number
  meetingNotes: MeetingNotesState
  pendingMediaCleanup: PendingMediaCleanup[]
}

export interface RoomCapabilities {
  text: true
  audio: true
  screenShare: true
  files: true
  agentText: true
  agentImages: true
  agentTargeting: true
}

export interface AgentEvent {
  sequence: number
  type: "text" | "action" | "image"
  participant: {
    id: string
    name: string
    kind: ParticipantKind
  }
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  attachment?: Pick<RoomAttachment, "id" | "fileName" | "mimeType" | "size">
  addressed: boolean
  createdAt: number
}
