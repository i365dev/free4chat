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
  // Private revocation metadata retained while the public `tracks` entry is
  // announced after the Runtime's bounded silent publisher priming. The
  // Runtime does not drain user PCM until a Human subscription ACKs readiness.
  agentPublishedTrackName?: string
  // Set only after a Human has completed the remote-track negotiation for the
  // current Agent Voice publication. Private readiness bookkeeping; never
  // broadcast or returned from room_info.
  agentVoiceReady?: boolean
}

// #176 Phase A (canonical Room model, #178 review): one coarse, secret-free
// readiness projection PER Runtime Host, stored once in RoomRecord
// .runtimeHosts and shared by every resident Agent of that host. The
// runtimeHostId is a stable opaque, Room-scoped grouping key derived by the
// local Runtime (never hostname/username/IP/MAC, never the raw root seed);
// the speech booleans mean "this host can currently produce STT/TTS if a
// Room grant authorizes it". Discovery metadata only — never authorization,
// never a credential detail.
export interface RuntimeHostProjection {
  runtimeHostId: string
  speech: { stt: boolean; tts: boolean }
}

// #176 Phase B: private durable verification material for the explicit
// Human-to-Runtime-Host association. This is RoomRecord-only storage; never
// send it in RoomState, room_info, Harness context, logs, or diagnostics.
export interface RuntimeHostProviderAssociation {
  humanParticipantId: string
  claimedAt: number
  providerHandleHash: string
  // Server-private proof membership. A Runtime Host id is public discovery
  // metadata, so an association remains live only while at least one current
  // Agent on this Host has actually proved possession of the private handle.
  // Never project these ids to RoomState or room_info.
  verifiedParticipantIds: string[]
}

// Browser-safe projection for future Human-facing feature admission. Both ids
// are already Room-scoped/public; neither a claim nor provider capability is.
export interface RuntimeHostProviderPublicAssociation {
  humanParticipantId: string
  claimedAt: number
}

// One-time claim bookkeeping only. `claimHash` is the map key and remains
// server-private because it is redemption-capable until consumed or expired.
export interface PendingRuntimeHostProviderClaim {
  humanParticipantId: string
  expiresAt: number
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
  // #176 Phase A (canonical Room model): the Room-scoped Runtime Host id
  // behind this Agent (agents only). Readiness lives ONCE per host in
  // RoomRecord.runtimeHosts, shared by all same-host Agents; the credential
  // itself never becomes Room state.
  runtimeHostId?: string
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

// Room-wide Live Transcript is shared, bounded context — not an Agent grant
// and not a media capability. `producerRuntimeHostId` is deliberately only
// public discovery/grouping metadata; the private Runtime Host provider
// association remains the authorization proof in RoomRecord.
export type LiveTranscriptState =
  | { active: false }
  | {
      active: true
      producerRuntimeHostId: string
      startedByHumanParticipantId: string
      epoch: number
      startedAt: number
    }

// A committed, Room-scoped STT result. Sequence and createdAt are assigned by
// RoomSession; speaker is derived from the current Human participant rather
// than trusted from a Runtime callback.
export interface LiveTranscriptSegment {
  segmentId: string
  epoch: number
  sequence: number
  participantId: string
  speaker: string
  text: string
  createdAt: number
}

// A Room-wide publish authorization for one currently connected Agent. The
// entry exists only while enabled; absence means muted. enabledAt is the
// participant-specific authorization epoch consumed by resident Runtimes.
export interface AgentVoiceGrant {
  enabled: true
  enabledAt: number
}

// Canonical Agent Voice authorization. This deliberately carries no false
// entries and no Runtime Host details: readiness belongs to runtimeHosts and
// authorization belongs to the participant that will publish the audio.
export type AgentVoiceState = Record<string, AgentVoiceGrant>

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
  // #176 Phase A: one readiness projection per Runtime Host id (see
  // RoomRecord.runtimeHosts).
  runtimeHosts?: Record<string, RuntimeHostProjection>
  // #176 Phase B: explicit Room-scoped Human ↔ Runtime Host associations.
  // The corresponding claim/provider-handle material is server-private.
  runtimeHostProviders?: Record<string, RuntimeHostProviderPublicAssociation>
  messages: RoomMessage[]
  // Present on every current RoomSession projection. Optional in the wire
  // contract so older browser clients that cached the prior state shape keep
  // decoding RoomState safely.
  liveTranscript?: LiveTranscriptState
  liveTranscriptSegments?: LiveTranscriptSegment[]
  meetingNotes: MeetingNotesState
  // Whether the server-side Meeting Notes media capability (the
  // AGENT_MEDIA_ENABLED master switch) is on in this environment at all —
  // independent of whether any grant is currently active. The client must
  // never offer Start, and must never claim "Listening", when this is
  // false: every actual Runtime media request would 403 regardless of the
  // room-visible grant.
  meetingNotesMediaAvailable: boolean
  agentVoice: AgentVoiceState
  // Coarse Worker media admission switch. Per-Agent UI availability still
  // comes from the Runtime Host's TTS readiness, never from this field.
  agentVoiceMediaAvailable: boolean
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
  // #176 Phase A (canonical Room model): ONE readiness projection per
  // Runtime Host id, shared by all same-host Agents. Garbage-collected when
  // no participant references the host anymore.
  runtimeHosts?: Record<string, RuntimeHostProjection>
  // Server-private Phase B authorization state. `runtimeHostProviders`
  // retains only a one-way provider handle hash; claims are hash-keyed and
  // short-lived. Neither is copied into RoomState.
  runtimeHostProviders?: Record<string, RuntimeHostProviderAssociation>
  runtimeHostProviderClaims?: Record<string, PendingRuntimeHostProviderClaim>
  messages: RoomMessage[]
  liveTranscript: LiveTranscriptState
  liveTranscriptSegments: LiveTranscriptSegment[]
  // Next values to allocate. They are Room-local counters, never timestamps
  // or ordinary message/event cursors.
  nextLiveTranscriptEpoch: number
  nextTranscriptSequence: number
  attachments: RoomAttachment[]
  nextMessageSequence: number
  meetingNotes: MeetingNotesState
  agentVoice: AgentVoiceState
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
