import type { Message } from "./types"

/**
 * RoomState is authoritative for text/actions, while file messages are
 * intentionally session-local DataChannel messages. Keep both sources in
 * the rendered timeline without letting a state refresh discard files.
 */
export function mergeRoomAndEphemeralMessages(
  roomMessages: Message[],
  ephemeralMessages: Message[],
): Message[] {
  return [...roomMessages, ...ephemeralMessages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftCreatedAt = left.message.createdAt ?? 0
      const rightCreatedAt = right.message.createdAt ?? 0
      return leftCreatedAt - rightCreatedAt || left.index - right.index
    })
    .map(({ message }) => message)
}
