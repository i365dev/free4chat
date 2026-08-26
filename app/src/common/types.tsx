import type { CollabEvent, RoomSurfaceV1 } from "../room/types"

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
  capabilities?: string[]
  surface?: RoomSurfaceV1
}

export type MessageType = "text" | "image" | "file" | "action"

export type ActionType =
  "whiteboard" | "poll" | "vote" | "game" | "reaction" | "collab"

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
  collab?: CollabEvent
}

export interface Color {
  r: string
  g: string
  b: string
}
