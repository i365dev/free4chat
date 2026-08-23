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
  attachment?: RoomAttachmentMetadata
  addressed: boolean
  createdAt: number
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
  addressed: boolean
  attachment?: RoomAttachmentMetadata
  image?: HarnessImage
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
  room: { ephemeral: true }
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
}

export interface Free4ChatClient {
  connect(): Promise<void>
  listTools(): Promise<string[]>
  roomInfo(roomId: string): Promise<RoomInfo>
  joinRoom(roomId: string, name: string): Promise<JoinResult>
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
  ): Promise<{ data: string; mimeType: string }>
  leaveRoom(participantHandle: string): Promise<void>
  close(): Promise<void>
}
