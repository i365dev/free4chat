import type { Message } from "./types"

/**
 * RoomState is authoritative for text/actions, while file messages are
 * intentionally session-local DataChannel messages. Keep both sources in
 * the rendered timeline without letting a state refresh discard files.
 */
export function mergeRoomAndEphemeralMessages(
  roomMessages: Message[],
  ephemeralMessages: Message[]
): Message[] {
  return [...roomMessages, ...ephemeralMessages]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftSequence = left.message.sequence
      const rightSequence = right.message.sequence
      const leftAfterSequence = left.message.afterSequence
      const rightAfterSequence = right.message.afterSequence
      const hasLeftSequence =
        typeof leftSequence === "number" &&
        Number.isSafeInteger(leftSequence) &&
        leftSequence >= 0
      const hasRightSequence =
        typeof rightSequence === "number" &&
        Number.isSafeInteger(rightSequence) &&
        rightSequence >= 0
      const hasLeftAnchor =
        typeof leftAfterSequence === "number" &&
        Number.isSafeInteger(leftAfterSequence) &&
        leftAfterSequence >= 0
      const hasRightAnchor =
        typeof rightAfterSequence === "number" &&
        Number.isSafeInteger(rightAfterSequence) &&
        rightAfterSequence >= 0

      // Room messages occupy their canonical integer sequence. An ephemeral
      // file anchored after N belongs after all Room messages <= N and before
      // later Room messages. This is causal ordering, not wall-clock fusion.
      if (hasLeftSequence && hasRightSequence)
        return leftSequence - rightSequence || left.index - right.index
      if (hasLeftSequence && hasRightAnchor)
        return leftSequence <= rightAfterSequence ? -1 : 1
      if (hasLeftAnchor && hasRightSequence)
        return rightSequence <= leftAfterSequence ? 1 : -1
      if (hasLeftAnchor && hasRightAnchor)
        return (
          leftAfterSequence - rightAfterSequence || left.index - right.index
        )

      // Legacy/old-client ephemeral messages have no causal anchor. Keep
      // their previous local fallback order, after anchored Room content.
      if (hasLeftSequence || hasLeftAnchor) return -1
      if (hasRightSequence || hasRightAnchor) return 1
      const leftCreatedAt = left.message.createdAt ?? 0
      const rightCreatedAt = right.message.createdAt ?? 0
      return leftCreatedAt - rightCreatedAt || left.index - right.index
    })
    .map(({ message }) => message)
}
