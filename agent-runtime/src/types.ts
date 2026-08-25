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

export interface Free4ChatClient {
  connect(): Promise<void>
  listTools(): Promise<string[]>
  roomInfo(roomId: string): Promise<RoomInfo>
  joinRoom(
    roomId: string,
    name: string,
    capabilities?: string[]
  ): Promise<JoinResult>
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
  leaveRoom(participantHandle: string): Promise<void>
  close(): Promise<void>
}
