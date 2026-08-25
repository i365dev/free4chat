import type { Message } from "../common/types"

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
