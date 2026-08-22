export type AgentAdapterName = "hermes" | "codex" | "claude" | "pi"

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

export interface HarnessTurnInput {
  room: { ephemeral: true }
  events: HarnessEvent[]
}

export interface HarnessTurnResult {
  text?: string
}

export interface HarnessAdapter {
  readonly name: AgentAdapterName
  ensureSession(): Promise<void>
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>
  close(): Promise<void>
}

export interface JoinResult {
  participantId: string
  participantHandle: string
  cursor: number
  expiresAt: number
}

export interface WaitResult {
  events: RoomEvent[]
  cursor: number
  expiresAt: number
}

export interface Free4ChatClient {
  connect(): Promise<void>
  listTools(): Promise<string[]>
  roomInfo(roomId: string): Promise<unknown>
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
