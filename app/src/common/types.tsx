export interface UserInfo {
  name: string
  room: string
  className?: string
  audioStream?: MediaStream | null
  screenShareStream?: MediaStream | null
  screenShareEnabled?: boolean
  peerId: string
  muteState?: boolean | false
}

export type MessageType = "text" | "image" | "file"

export interface Message {
  peerId: string
  name: string
  type: MessageType
  text?: string
  fileLink?: string
  fileName?: string
  fileSize?: number
}

export interface Color {
  r: string
  g: string
  b: string
}
