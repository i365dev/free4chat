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

export interface RoomAttachment {
  id: string
  senderId: string
  senderName: string
  mimeType: AgentImageMimeType
  fileName: string
  size: number
  chunkCount: number
  createdAt: number
  sequence: number
}

export interface RoomState {
  createdAt: number
  expiresAt: number
  participants: Array<Omit<RoomParticipant, "token" | "connectionNonce">>
  messages: RoomMessage[]
}

export interface RoomRecord {
  createdAt: number
  expiresAt: number
  participants: Record<string, RoomParticipant>
  messages: RoomMessage[]
  attachments: RoomAttachment[]
  nextMessageSequence: number
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
