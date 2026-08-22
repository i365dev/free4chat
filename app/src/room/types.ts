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
  nextMessageSequence: number
}

export interface RoomCapabilities {
  text: true
  audio: true
  screenShare: true
  files: true
  agentText: true
}

export interface AgentEvent {
  sequence: number
  type: "text" | "action"
  participant: {
    id: string
    name: string
    kind: ParticipantKind
  }
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  createdAt: number
}
