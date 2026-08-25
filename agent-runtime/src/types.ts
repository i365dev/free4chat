export type LauncherMaturity = "native" | "bridge" | "preview"
export type LauncherSecurity = "trusted-room" | "unverified"

export interface AgentLauncher {
  id: string
  displayName: string
  command: string
  args: string[]
  maturity: LauncherMaturity
  security: LauncherSecurity
  notes?: string
  /** Explicit launch-time environment overrides for this trusted launcher. */
  environment?: Record<string, string>
}

export interface HarnessCapabilities {
  text: true
  images: boolean
  resume: boolean
}

export interface RoomAttachmentMetadata {
  id: string
  fileName: string
  mimeType: string
  size: number
}

export interface RoomEvent {
  sequence: number
  type: "text" | "action" | "image"
  participant: {
    id: string
    name: string
    kind: "human" | "agent"
  }
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  /** #106 Phase B wire envelope on action messages with actionType "collab". */
  collab?: WireCollabEvent
  attachment?: RoomAttachmentMetadata
  /** Runtime-enriched for supported text attachments (#90/#82): decoded
   * UTF-8 content, size-capped before it ever reaches the Harness. */
  textFile?: { fileName: string; mimeType: string; content: string }
  addressed: boolean
  createdAt: number
}

export type CollabKind =
  "request" | "accepted" | "declined" | "completed" | "failed"

export interface WireCollabEvent {
  requestId: string
  kind: CollabKind
  fromParticipantId: string
  targetParticipantId: string
  summary?: string
  details?: Record<string, string>
  attachmentIds?: string[]
}

/** Harness-facing collaboration view: identical to the wire envelope plus a
 * resolved fromName so the recipient never parses prose or joins rosters. */
export interface CollabEventView extends WireCollabEvent {
  fromName: string
}

export interface ParticipantRosterEntry {
  id: string
  name: string
  kind: "human" | "agent"
  advertised?: string[]
  /** #111 sanitized workspace-snapshot metadata for this agent, when one is
   * currently published. Metadata only — never bytes or capture sources. */
  surface?: RoomSurfaceMetadataV1
}

/** #111 v1 workspace-snapshot metadata (sanitized projection). */
export interface RoomSurfaceMetadataV1 {
  snapshotId: string
  mimeType: string
  size: number
  updatedAt: number
}

export interface RoomSelfContext {
  instanceId: string
  participantId?: string
  name: string
  capabilities?: string[]
}

export interface HarnessImage {
  type: "image"
  data: string
  mimeType: string
}

export interface HarnessEvent {
  sender: string
  kind: "human" | "agent"
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  collab?: CollabEventView
  addressed: boolean
  attachment?: RoomAttachmentMetadata
  image?: HarnessImage
  textFile?: { fileName: string; mimeType: string; content: string }
  sequence: number
  createdAt: number
}

export interface HarnessTranscriptSegment {
  participantId: string
  speaker: string
  text: string
}

export interface HarnessMeetingTranscript {
  /** Runtime-local temporary file; never a Worker/DO attachment or URL. */
  path: string
  segments: HarnessTranscriptSegment[]
}

export interface HarnessTurnInput {
  room: {
    ephemeral: true
    self?: RoomSelfContext
    participants?: ParticipantRosterEntry[]
  }
  events: HarnessEvent[]
  meetingTranscript?: HarnessMeetingTranscript
}

export interface HarnessTurnResult {
  text?: string
}

export interface HarnessAdapter {
  readonly name: string
  readonly capabilities?: HarnessCapabilities
  ensureSession(): Promise<void>
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>
  onFailure?(handler: (error: Error) => void): void
  cancelTurn?(): Promise<void>
  close(): Promise<void>
}

export interface JoinResult {
  participantId: string
  participantHandle: string
  cursor: number
  expiresAt: number
}

/** #51 portable public invite descriptor v1. Safe to hand to any Agent or
 * Human over an existing channel: room identity plus a Human-convenience
 * URL only — never handles, tokens, credentials, or bootstrap endpoints. */
export interface RoomInviteDescriptorV1 {
  kind: "free4chat.room-invite"
  version: 1
  roomId: string
  roomUrl: string
}

export interface CreateRoomResult extends JoinResult {
  invite: RoomInviteDescriptorV1
}

/** Room-visible Meeting Notes grant (#82) — never a capability secret. */
export interface MeetingNotesInfo {
  active: boolean
  agentParticipantId?: string
  startedAt?: number
}

export interface RoomInfo {
  exists: boolean
  /** Connected-participant/capability projection (#106): lets an Agent
   * discover peers and their advertised tokens even with no triggering room
   * event. Never contains tokens or media identifiers. */
  participants?: ParticipantRosterEntry[]
  meetingNotes: MeetingNotesInfo
  // Whether the server-side Meeting Notes media capability (the
  // AGENT_MEDIA_ENABLED master switch) is on at all in this environment —
  // independent of whether `meetingNotes` names this Agent. Required, not
  // optional: MeetingNotesController treats an active grant as authorized
  // only when this is also true, so every caller must be explicit rather
  // than accidentally failing open on a missing field.
  meetingNotesMediaAvailable: boolean
}

export interface WaitResult {
  events: RoomEvent[]
  cursor: number
  expiresAt: number
  participants?: ParticipantRosterEntry[]
}

export interface CollabRequestArgs {
  targetParticipantId: string
  summary: string
  requestId?: string
  details?: Record<string, string>
  attachmentIds?: string[]
}

export interface CollabResultArgs {
  requestId: string
  status: "completed" | "failed"
  summary: string
  details?: Record<string, string>
  attachmentIds?: string[]
}

export interface AttachmentUpload {
  fileName: string
  mimeType: string
  dataBase64: string
}

export type UploadedAttachment = RoomAttachmentMetadata & { sequence: number }

export interface SurfacePublishPayload {
  mimeType: string
  dataBase64: string
}

export interface SurfaceReadResult {
  surface: RoomSurfaceMetadataV1
  /** Base64 image bytes, valid only for the exact requested snapshotId. */
  data: string
}

export interface Free4ChatClient {
  connect(): Promise<void>
  listTools(): Promise<string[]>
  roomInfo(roomId: string): Promise<RoomInfo>
  joinRoom(
    roomId: string,
    name: string,
    capabilities?: string[]
  ): Promise<JoinResult>
  /** #51: create-only fresh-room creation; the caller becomes participant #1
   * of an ordinary room with no owner authority. */
  createRoom(name: string, capabilities?: string[]): Promise<CreateRoomResult>
  waitForEvents(
    participantHandle: string,
    cursor: number,
    timeoutSeconds: number
  ): Promise<WaitResult>
  sendText(
    participantHandle: string,
    text: string
  ): Promise<{ sequence: number }>
  readAttachment(
    participantHandle: string,
    attachmentId: string
  ): Promise<{ data: string; mimeType: string; text?: string }>
  updateCapabilities(
    participantHandle: string,
    capabilities: string[]
  ): Promise<void>
  sendCollabRequest(
    participantHandle: string,
    args: CollabRequestArgs
  ): Promise<{ requestId: string; sequence: number; duplicate?: boolean }>
  sendCollabResponse(
    participantHandle: string,
    requestId: string,
    decision: "accepted" | "declined",
    summary?: string
  ): Promise<{ sequence: number }>
  sendCollabResult(
    participantHandle: string,
    args: CollabResultArgs
  ): Promise<{ sequence: number }>
  uploadAttachment(
    participantHandle: string,
    file: AttachmentUpload
  ): Promise<UploadedAttachment>
  /** #111: publish/replace this Agent's single workspace snapshot. */
  publishSurface(
    participantHandle: string,
    payload: SurfacePublishPayload
  ): Promise<{ surface: RoomSurfaceMetadataV1 }>
  clearSurface(participantHandle: string): Promise<void>
  readSurface(
    participantHandle: string,
    sourceParticipantId: string,
    snapshotId: string
  ): Promise<SurfaceReadResult>
  leaveRoom(participantHandle: string): Promise<void>
  close(): Promise<void>
}
