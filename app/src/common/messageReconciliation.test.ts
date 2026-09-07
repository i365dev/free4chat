import { describe, expect, it } from "vitest"

import { reconcileCanonicalRoomMessages } from "./messageReconciliation"
import type { Message } from "./types"

function message(
  messageId: string | undefined,
  sequence: number | undefined,
  text: string
): Message {
  return {
    peerId: "agent-a",
    name: "Agent A",
    kind: "agent",
    type: "text",
    messageId,
    sequence,
    text,
  }
}

describe("reconcileCanonicalRoomMessages", () => {
  it("reuses stable messageId or sequence identities across fresh snapshots", () => {
    const byId = message("message-1", 1, "one")
    const bySequence = message(undefined, 2, "two")
    const previous = [byId, bySequence]
    const next = [
      { ...byId },
      { ...bySequence },
      message("message-3", 3, "three"),
    ]

    const reconciled = reconcileCanonicalRoomMessages(previous, next)

    expect(reconciled).toEqual(next)
    expect(reconciled[0]).toBe(byId)
    expect(reconciled[1]).toBe(bySequence)
    expect(reconciled[2]).toBe(next[2])
  })

  it("does not reuse an object when messageId and sequence collide", () => {
    const previousById = message("message-1", 1, "one")
    const previousBySequence = message("message-2", 2, "two")
    const next = message("message-1", 2, "conflicting snapshot")

    const [reconciled] = reconcileCanonicalRoomMessages(
      [previousById, previousBySequence],
      [next]
    )

    expect(reconciled).toBe(next)

    const changedId = message("message-3", 2, "different canonical message")
    const [notReconciled] = reconcileCanonicalRoomMessages(
      [previousBySequence],
      [changedId]
    )
    expect(notReconciled).toBe(changedId)
  })
})
