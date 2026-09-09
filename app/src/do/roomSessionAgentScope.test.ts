import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"

describe("RoomSession AgentEvent task scope projection (#303)", () => {
  it("derives task scopes from targeted collab requestIds and leaves ordinary text in Room scope", () => {
    const session = new RoomSession({} as never, { SFU_ROOM: {} } as never)
    const project = (message: unknown, participantId: string) =>
      (
        session as unknown as {
          toAgentEvent: (message: unknown, participantId: string) => unknown
        }
      ).toAgentEvent(message, participantId) as Record<string, unknown>

    const messages = [
      {
        sequence: 1,
        type: "action",
        peerId: "human",
        name: "Human",
        kind: "human",
        actionType: "collab",
        collab: {
          requestId: "T",
          kind: "request",
          fromParticipantId: "human",
          targetParticipantId: "agent-a",
        },
        targets: ["agent-a"],
        createdAt: 1,
      },
      {
        sequence: 2,
        type: "action",
        peerId: "human",
        name: "Human",
        kind: "human",
        actionType: "collab",
        collab: {
          requestId: "U",
          kind: "request",
          fromParticipantId: "human",
          targetParticipantId: "agent-a",
        },
        targets: ["agent-a"],
        createdAt: 2,
      },
      {
        sequence: 3,
        type: "text",
        peerId: "human",
        name: "Human",
        kind: "human",
        text: "ordinary Room message",
        targets: ["agent-a"],
        createdAt: 3,
      },
    ]

    const projected = messages.map((message) => project(message, "agent-a"))
    expect(projected.map((event) => event.scopeId)).toEqual([
      "task:T",
      "task:U",
      undefined,
    ])
    expect(projected.every((event) => event.addressed === true)).toBe(true)

    const serialized = JSON.parse(JSON.stringify(projected[0])) as Record<
      string,
      unknown
    >
    expect(serialized.scopeId).toBe("task:T")
    expect(project(messages[0], "agent-b").scopeId).toBeUndefined()
  })
})
