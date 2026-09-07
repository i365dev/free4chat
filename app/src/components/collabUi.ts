import type { Message } from "../common/types"

export interface CollabLifecycleProjection {
  answered: boolean
  accepted: boolean
  declined: boolean
  terminal: boolean
}

/**
 * Build the presentation-only collaboration lifecycle view once per message
 * set. The canonical Room message log remains the source of truth; this map
 * just avoids making every action card rescan that log independently.
 */
export function buildCollabLifecycleIndex(
  messages: Message[]
): Map<string, CollabLifecycleProjection> {
  const index = new Map<string, CollabLifecycleProjection>()
  for (const message of messages) {
    const collab = message.collab
    if (!collab) continue

    const current =
      index.get(collab.requestId) ??
      ({
        answered: false,
        accepted: false,
        declined: false,
        terminal: false,
      } satisfies CollabLifecycleProjection)

    if (collab.kind === "accepted") {
      current.accepted = true
      current.answered = true
    } else if (collab.kind === "declined") {
      current.declined = true
      current.answered = true
    } else if (collab.kind === "completed" || collab.kind === "failed") {
      current.terminal = true
    }

    index.set(collab.requestId, current)
  }
  return index
}

/** #115: lifecycle-derived answered state for a collab request card. The
 * message log IS the record — a later accepted/declined envelope with the
 * same requestId means the decision is made, so response controls must
 * disappear (page reload / resync included). Never React-local state. */
export function isCollabRequestAnswered(
  messages: Message[],
  requestId: string
): boolean {
  return messages.some(
    (m) =>
      m.collab?.requestId === requestId &&
      (m.collab.kind === "accepted" || m.collab.kind === "declined")
  )
}

/** #115: an accepted envelope exists for this requestId. */
export function isCollabRequestAccepted(
  messages: Message[],
  requestId: string
): boolean {
  return messages.some(
    (m) => m.collab?.requestId === requestId && m.collab.kind === "accepted"
  )
}

/** #121: a terminal result (completed | failed) exists for this requestId.
 * Declined is its own end and does not count here. */
export function hasCollabTerminalResult(
  messages: Message[],
  requestId: string
): boolean {
  return messages.some(
    (m) =>
      m.collab?.requestId === requestId &&
      (m.collab.kind === "completed" || m.collab.kind === "failed")
  )
}
