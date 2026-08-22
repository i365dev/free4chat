export interface UserInfo {
  name: string
  kind: "human" | "agent"
  room: string
  className?: string
  audioStream?: MediaStream | null
  screenShareStream?: MediaStream | null
  screenShareEnabled?: boolean
  peerId: string
  muteState?: boolean | false
}

export type MessageType = "text" | "image" | "file" | "action"

export type ActionType = "whiteboard" | "poll" | "vote" | "game" | "reaction"

export interface Message {
  peerId: string
  name: string
  kind?: "human" | "agent"
  type: MessageType
  messageId?: string
  createdAt?: number
  sequence?: number
  ephemeral?: boolean
  text?: string
  fileLink?: string
  fileName?: string
  fileSize?: number
  actionType?: ActionType
  actionPayload?: Record<string, string>
}

export interface Color {
  r: string
  g: string
  b: string
}
