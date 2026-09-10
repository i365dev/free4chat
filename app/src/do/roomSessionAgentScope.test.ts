import { describe, expect, it } from "vitest"

import { RoomSession } from "./RoomSession"
import { buildTaskProjectionIndex } from "./taskScope"
import type { RoomMessage, RoomParticipant } from "../room/types"

function participant(id: string, kind: "human" | "agent"): RoomParticipant {
  return {
    id,
    name: id,
    kind,
    connected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `${id}-token`,
  }
}

describe("RoomSession AgentEvent task scope projection (#314)", () => {
  it("omits Task events from unrelated Agents instead of falling back to Room", () => {
    const session = new RoomSession({} as never, { SFU_ROOM: {} } as never)
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
    ] as RoomMessage[]
    const participants = {
      human: participant("human", "human"),
      "agent-a": participant("agent-a", "agent"),
      "agent-b": participant("agent-b", "agent"),
    }
    const projection = buildTaskProjectionIndex(messages, participants)
    const project = (message: RoomMessage, participantId: string) =>
      (
        session as unknown as {
          toAgentEvent: (
            message: RoomMessage,
            participantId: string,
            projection: ReturnType<typeof buildTaskProjectionIndex>
          ) => Record<string, unknown> | undefined
        }
      ).toAgentEvent(message, participantId, projection)

    const projected = messages.map((message) => project(message, "agent-a"))
    expect(projected.map((event) => event?.scopeId)).toEqual([
      "task:T",
      "task:U",
      undefined,
    ])
    expect(projected.every((event) => event?.addressed === true)).toBe(true)

    expect(project(messages[0], "agent-b")).toBeUndefined()
    expect(project(messages[1], "agent-b")).toBeUndefined()
    expect(project(messages[2], "agent-b")).toMatchObject({
      addressed: false,
    })
  })
})
