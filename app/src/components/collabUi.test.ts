import { describe, expect, it } from "vitest"

import type { Message } from "@common/types"

import { isCollabRequestAnswered } from "./collabUi"
function collab(
  requestId: string,
  kind: "request" | "accepted" | "declined" | "completed" | "failed"
): Message {
  return {
    peerId: "someone",
    name: "someone",
    type: "action",
    actionType: "collab",
    sequence: 1,
    collab: {
      requestId,
      kind,
      fromParticipantId: "x",
      targetParticipantId: "y",
    },
  }
}

describe("isCollabRequestAnswered (#115)", () => {
  it("unanswered when only the request exists", () => {
    expect(isCollabRequestAnswered([collab("r1", "request")], "r1")).toBe(false)
  })

  it("answered once an accepted or declined envelope with the same requestId exists", () => {
    const log = [collab("r1", "request"), collab("r1", "declined")]
    expect(isCollabRequestAnswered(log, "r1")).toBe(true)
    expect(
      isCollabRequestAnswered(
        [collab("r1", "request"), collab("r1", "accepted")],
        "r1"
      )
    ).toBe(true)
  })

  it("completed/failed do NOT count as the accept/decline decision", () => {
    const log = [collab("r1", "request"), collab("r1", "completed")]
    expect(isCollabRequestAnswered(log, "r1")).toBe(false)
  })

  it("ignores decisions for other requests", () => {
    const log = [collab("r1", "request"), collab("r2", "accepted")]
    expect(isCollabRequestAnswered(log, "r1")).toBe(false)
  })
})
