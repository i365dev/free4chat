import { describe, expect, it } from "vitest"

import {
  buildTaskProjections,
  roomMessagesForView,
  taskHasConnectedAgent,
} from "./taskViews"
import type { Message } from "./types"

const request = (requestId: string, summary: string): Message => ({
  peerId: "human",
  name: "Human",
  kind: "human",
  type: "action",
  actionType: "collab",
  collab: {
    requestId,
    kind: "request",
    fromParticipantId: "human",
    targetParticipantId: "agent-x",
    summary,
  },
})

describe("task interaction projections (#309)", () => {
  it("derives Room, T, and U views from canonical messages without a task store", () => {
    const taskT = request("T", "Migration plan")
    const taskU = request("U", "U marker")
    const messages: Message[] = [
      { peerId: "human", name: "Human", type: "text", text: "ROOM" },
      taskT,
      {
        peerId: "agent-x",
        name: "Agent",
        kind: "agent",
        type: "action",
        actionType: "collab",
        collab: {
          requestId: "T",
          kind: "accepted",
          fromParticipantId: "agent-x",
          targetParticipantId: "human",
          summary: "working",
        },
      },
      {
        peerId: "agent-x",
        name: "Agent",
        kind: "agent",
        type: "text",
        text: "T output",
        taskRequestId: "T",
      },
      taskU,
      {
        peerId: "human",
        name: "Human",
        kind: "human",
        type: "text",
        text: "T follow-up",
        taskRequestId: "T",
      },
      {
        peerId: "agent-x",
        name: "Agent",
        kind: "agent",
        type: "text",
        text: "U output",
        taskRequestId: "U",
      },
    ]

    expect(
      roomMessagesForView(messages).map((message) => message.text)
    ).toEqual(["ROOM"])
    const projections = buildTaskProjections(messages)
    expect(
      projections.map(({ requestId, title, status }) => ({
        requestId,
        title,
        status,
      }))
    ).toEqual([
      { requestId: "T", title: "Migration plan", status: "Working" },
      { requestId: "U", title: "U marker", status: "Starting" },
    ])
    expect(projections[0]?.messages.map((message) => message.text)).toEqual([
      undefined,
      undefined,
      "T output",
      "T follow-up",
    ])
    expect(projections[1]?.messages.map((message) => message.text)).toEqual([
      undefined,
      "U output",
    ])
  })

  it("projects terminal lifecycle states without adding new status vocabulary", () => {
    const task = request("T", "Task")
    const terminal: Message = {
      ...task,
      collab: {
        ...task.collab!,
        kind: "completed",
        fromParticipantId: "agent-x",
        targetParticipantId: "human",
      },
    }
    expect(buildTaskProjections([task, terminal])[0]?.status).toBe("Completed")
  })

  it("keeps secondary Task Agents available from structured Task targets", () => {
    const task = request("T", "Task")
    const followUp: Message = {
      peerId: "human",
      name: "Human",
      kind: "human",
      type: "text",
      taskRequestId: "T",
      targets: ["agent-pi"],
      text: "Pi, please continue this Task",
    }
    const projection = buildTaskProjections([task, followUp])[0]

    expect(projection?.participatingAgentIds).toContain("agent-x")
    expect(projection?.participatingAgentIds).toContain("agent-pi")
    expect(
      taskHasConnectedAgent(projection!, [
        { peerId: "agent-pi", kind: "agent" },
      ])
    ).toBe(true)
    expect(taskHasConnectedAgent(projection!, [])).toBe(false)
  })

  it("keeps Task-scoped permission lifecycle messages in the Task view", () => {
    const task = request("T", "Task")
    const taskU = request("U", "Other task")
    const permissionRequest: Message = {
      peerId: "agent-x",
      name: "Agent",
      kind: "agent",
      type: "action",
      actionType: "permission",
      taskRequestId: "T",
      permission: {
        requestId: "permission-T",
        kind: "request",
        agentParticipantId: "agent-x",
        toolCall: { title: "Run command" },
        options: [{ optionId: "allow", name: "Allow" }],
        createdAt: 2,
        expiresAt: 100,
      },
    }
    const permissionResolved: Message = {
      peerId: "human",
      name: "Human",
      kind: "human",
      type: "action",
      actionType: "permission",
      taskRequestId: "T",
      permission: {
        requestId: "permission-T",
        kind: "resolved",
        agentParticipantId: "agent-x",
        selectedOptionId: "allow",
        humanParticipantId: "human",
        humanName: "Human",
        createdAt: 3,
        expiresAt: 100,
      },
    }

    const messages = [task, permissionRequest, permissionResolved, taskU]
    expect(buildTaskProjections(messages)[0]?.messages).toEqual([
      task,
      permissionRequest,
      permissionResolved,
    ])
    expect(buildTaskProjections(messages)[1]?.messages).toEqual([taskU])
    expect(
      buildTaskProjections(messages)[1]?.messages.includes(permissionRequest)
    ).toBe(false)
    expect(roomMessagesForView(messages)).toEqual([])
  })

  it("keeps scoped messages in Room when their canonical request was evicted", () => {
    const orphan: Message = {
      peerId: "agent-x",
      name: "Agent",
      kind: "agent",
      type: "text",
      text: "orphaned task output",
      taskRequestId: "evicted-request",
    }

    expect(buildTaskProjections([orphan])).toEqual([])
    expect(roomMessagesForView([orphan])).toEqual([orphan])
  })
})
