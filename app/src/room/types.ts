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
  // Cloudflare-assigned mid of the agent's single published voice audio
  // track (#83) — the revocation handle for server-side close; never
  // broadcast to clients.
  agentPublishedMid?: string
  // Kept private until the Runtime confirms that the publication has
  // accepted its first PCM packet. At that point it is moved into `tracks`.
  agentPublishedTrackName?: string
}

export interface AgentCapabilities {
  text: true
  // #106 Phase A: the capability tokens this Agent explicitly chose to
  // advertise for THIS room (for example "code.edit", "browser.authenticated").
  // Pure discovery metadata chosen by the Runtime/Harness — never an
  // authorization grant, never scanned from installed tools, never a claim
  // another participant may invoke. Room-ephemeral: gone when the room is.
  advertised?: string[]
}

// #106 Phase B lifecycle: request → accepted | declined → completed | failed.
// Free4Chat transports these envelopes and correlates them by requestId; it
// never decides, retries, or interprets them.
export type CollabEventKind =
  | "request"
  | "accepted"
  | "declined"
  | "completed"
  | "failed"

export interface CollabEvent {
  requestId: string
  kind: CollabEventKind
  fromParticipantId: string
  targetParticipantId: string
  summary?: string
  details?: Record<string, string>
  attachmentIds?: string[]
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
  // #119: Human self-advertised capability tokens (discovery metadata only —
  // never authorization). Top-level field for Humans; Agents keep the nested
  // `capabilities.advertised` representation for backward compatibility.
  advertised?: string[]
  // #111 Observable Agent Workspace v0: metadata for this Agent's single
  // latest explicitly-published workspace snapshot. Metadata only — bytes
  // live in bounded DO chunk storage under surface:* keys and are readable
  // solely by current participants with a matching snapshotId. Opt-in,
  // Agent-only, own-surface-only; never authorization and never history.
  surface?: RoomSurfaceV1
  media?: RoomMediaState
}

// #111 v1 snapshot descriptor. kind is fixed; snapshotId is server-generated
// per successful publish; mimeType is one of the three supported image
// formats; size is byte count; updatedAt is the publish epoch ms.
export interface RoomSurfaceV1 {
  kind: "workspace-snapshot"
  snapshotId: string
  mimeType: AgentImageMimeType
  size: number
  updatedAt: number
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
  // Set only when actionType is "collab": the structured #106 Phase B
  // envelope validated by do/collab.ts. targets carries the addressed
  // participant so the event wakes exactly the targeted resident Runtime.
  collab?: CollabEvent
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
  | "text/yaml"
export type AgentAttachmentMimeType = AgentImageMimeType | AgentTextMimeType

// #117: every MIME the bounded room attachment store can legitimately hold
// (mirrors the DO/server allow-lists). Browser-safe: used for strict
// client-side validation of artifact read payloads.
export const ROOM_ATTACHMENT_MIME_TYPES: readonly AgentAttachmentMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/yaml",
]

/** #117: payload returned by the authenticated Human attachment read route.
 * Metadata is the safe public subset; `data` is base64 bytes validated
 * strictly against this metadata before any rendering. */
export interface RoomAttachmentRead {
  attachment: Pick<RoomAttachment, "id" | "fileName" | "mimeType" | "size">
  data: string
}

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

// Room-scoped voiceReply grant (#83): authorizes exactly one connected
// resident Agent to publish its single outbound audio track. Same shape as
// MeetingNotesState so "never granted" and "stopped" look identical.
export interface VoiceReplyState {
  active: boolean
  agentParticipantId?: string
  startedAt?: number
}

// Directional media permissions for an Agent media session (#83) — booleans
// only, never secrets or media identifiers.
export interface AgentMediaPermissions {
  canSubscribeHumanAudio: boolean
  canPublishVoice: boolean
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
  voiceReply: VoiceReplyState
  voiceReplyMediaAvailable: boolean
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
  voiceReply: VoiceReplyState
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
  collab?: CollabEvent
  attachment?: Pick<RoomAttachment, "id" | "fileName" | "mimeType" | "size">
  addressed: boolean
  createdAt: number
}
