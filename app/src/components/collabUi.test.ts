import { describe, expect, it } from "vitest"

import type { Message } from "@common/types"

import { hasCollabTerminalResult, isCollabRequestAnswered } from "./collabUi"
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

describe("terminal-result lifecycle helpers (#121)", () => {
  it("accepted marks the request accepted but not terminal", () => {
    const log = [collab("r1", "request"), collab("r1", "accepted")]
    expect(isCollabRequestAnswered(log, "r1")).toBe(true)
    expect(hasCollabTerminalResult(log, "r1")).toBe(false)
  })

  it("completed/failed are terminal", () => {
    for (const kind of ["completed", "failed"] as const) {
      const log = [collab("r1", "request"), collab("r1", kind)]
      expect(isCollabRequestAnswered(log, "r1")).toBe(false)
      expect(hasCollabTerminalResult(log, "r1")).toBe(true)
    }
  })

  it("declined is answered AND terminal (no Human result controls after decline)", () => {
    const log = [collab("r1", "request"), collab("r1", "declined")]
    expect(isCollabRequestAnswered(log, "r1")).toBe(true)
    expect(hasCollabTerminalResult(log, "r1")).toBe(false)
  })

  it("decisions for other requestIds never leak into this lifecycle", () => {
    const log = [collab("r2", "accepted"), collab("r2", "completed")]
    expect(
      isCollabRequestAnswered(log, "r1") || hasCollabTerminalResult(log, "r1")
    ).toBe(false)
  })
})
