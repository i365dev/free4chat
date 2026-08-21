export type ParticipantKind = "human" | "agent"

export type SfuTrackKind = "audio" | "video"

export interface SfuTrack {
  trackName: string
  kind: SfuTrackKind
  mid?: string
}

export interface SfuParticipant {
  id: string
  name: string
  kind: ParticipantKind
  sessionId: string
  muted: boolean
  connected: boolean
  fileChannelReady?: boolean
  tracks: SfuTrack[]
  joinedAt: number
  lastSeenAt: number
  connectionNonce?: string
  token: string
}

export interface SfuMessage {
  id: string
  peerId: string
  name: string
  kind: ParticipantKind
  type: "text" | "action"
  text?: string
  actionType?: string
  actionPayload?: Record<string, string>
  createdAt: number
}

export interface SfuRoomState {
  createdAt: number
  expiresAt: number
  botEnabled: boolean
  participants: Array<Omit<SfuParticipant, "token" | "connectionNonce">>
  messages: SfuMessage[]
}

export interface SfuRoomRecord {
  createdAt: number
  expiresAt: number
  botEnabled: boolean
  participants: Record<string, SfuParticipant>
  messages: SfuMessage[]
}

export interface SfuSessionResponse {
  participantId: string
  participantToken: string
  sessionId: string
  expiresAt: number
  botEnabled: boolean
}
