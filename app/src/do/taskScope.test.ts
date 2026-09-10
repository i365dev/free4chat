import { describe, expect, it } from "vitest"

import {
  buildTaskProjectionIndex,
  projectTaskEvent,
  resolveAgentTaskTargets,
  resolveHumanTaskTargets,
  resolveTaskRequest,
} from "./taskScope"
import type { RoomMessage, RoomParticipant } from "../room/types"

function participant(
  id: string,
  kind: "human" | "agent",
  connected = true
): RoomParticipant {
  return {
    id,
    name: id,
    kind,
    connected,
    joinedAt: 1,
    lastSeenAt: 1,
    token: `${id}-token`,
  }
}

function request(sequence = 1): RoomMessage {
  return {
    id: "request-message",
    peerId: "human",
    name: "human",
    kind: "human",
    type: "action",
    actionType: "collab",
    collab: {
      requestId: "task-T",
      kind: "request",
      fromParticipantId: "human",
      targetParticipantId: "agent-a",
      summary: "Task T",
    },
    targets: ["agent-a"],
    createdAt: sequence,
    sequence,
  }
}

function taskText(
  sequence: number,
  peerId: string,
  targets?: string[]
): RoomMessage {
  return {
    id: `message-${sequence}`,
    peerId,
    name: peerId,
    kind: peerId === "human" ? "human" : "agent",
    type: "text",
    text: `task-${sequence}`,
    taskRequestId: "task-T",
    ...(targets ? { targets } : {}),
    createdAt: sequence,
    sequence,
  }
}

function orphanLifecycle(
  sequence: number,
  kind: "accepted" | "completed" | "failed"
): RoomMessage {
  return {
    id: `lifecycle-${kind}`,
    peerId: "agent-a",
    name: "agent-a",
    kind: "agent",
    type: "action",
    actionType: "collab",
    collab: {
      requestId: "task-T",
      kind,
      fromParticipantId: "agent-a",
      targetParticipantId: "agent-b",
      summary: `private ${kind}`,
    },
    targets: ["agent-b"],
    createdAt: sequence,
    sequence,
  }
}

function participants(): Record<string, RoomParticipant> {
  return {
    human: participant("human", "human"),
    "agent-a": participant("agent-a", "agent"),
    "agent-b": participant("agent-b", "agent"),
    "agent-c": participant("agent-c", "agent"),
  }
}

describe("Task scope projection", () => {
  it("hides unrelated Agents and admits an explicitly targeted Agent", () => {
    const messages = [
      request(),
      taskText(2, "human", ["agent-b"]),
      taskText(3, "agent-b"),
    ]
    const index = buildTaskProjectionIndex(messages, participants())

    expect(projectTaskEvent(index, messages[0], "agent-a")).toMatchObject({
      kind: "task",
      visible: true,
      scopeId: "task:task-T",
      addressed: true,
    })
    expect(projectTaskEvent(index, messages[0], "agent-c")).toEqual({
      kind: "task",
      visible: false,
    })
    expect(projectTaskEvent(index, messages[1], "agent-b")).toMatchObject({
      kind: "task",
      visible: true,
      scopeId: "task:task-T",
      addressed: true,
    })
    expect(projectTaskEvent(index, messages[2], "agent-a")).toMatchObject({
      kind: "task",
      visible: true,
      scopeId: "task:task-T",
      addressed: false,
    })
    expect(projectTaskEvent(index, messages[2], "agent-c")).toEqual({
      kind: "task",
      visible: false,
    })
    expect(projectTaskEvent(index, messages[0], "agent-b", true)).toMatchObject(
      {
        kind: "task",
        visible: true,
        scopeId: "task:task-T",
      }
    )
  })

  it("reconstructs participation from retained canonical messages", () => {
    const messages = [request(), taskText(2, "human", ["agent-b"])]
    const rebuilt = buildTaskProjectionIndex(messages, participants())
    const resolution = resolveTaskRequest(rebuilt, "task-T", participants())

    expect(resolution).toMatchObject({
      ok: true,
      primaryAgentParticipantId: "agent-a",
      agentParticipantIds: ["agent-a", "agent-b"],
    })
  })

  it("fails closed for orphaned Task text and lifecycle after ring eviction", () => {
    const retained = [
      ...Array.from({ length: 99 }, (_, index) => ({
        ...taskText(index + 2, "agent-a"),
        taskRequestId: undefined,
        collab: undefined,
        actionType: undefined,
        text: `room-${index + 2}`,
      })),
      orphanLifecycle(101, "accepted"),
      orphanLifecycle(102, "completed"),
      orphanLifecycle(103, "failed"),
    ].slice(-100)
    const orphanedText = {
      ...taskText(104, "agent-a", ["agent-b"]),
      taskRequestId: "evicted-task",
    }
    const index = buildTaskProjectionIndex(retained, participants())

    for (const message of [
      orphanedText,
      ...retained.filter((entry) => entry.collab?.requestId === "task-T"),
    ]) {
      for (const participantId of ["agent-a", "agent-b"]) {
        expect(projectTaskEvent(index, message, participantId)).toEqual({
          kind: "task",
          visible: false,
        })
        expect(projectTaskEvent(index, message, participantId, true)).toEqual({
          kind: "task",
          visible: false,
        })
      }
    }
  })

  it("validates Human task targets without falling back", () => {
    const index = buildTaskProjectionIndex([request()], participants())
    const resolution = resolveTaskRequest(index, "task-T", participants())
    if (!resolution || resolution.ok === false) throw new Error("task missing")
    const human = participants().human

    expect(
      resolveHumanTaskTargets(resolution, human, participants(), undefined, 8)
    ).toEqual({ ok: true, targets: ["agent-a"] })
    expect(
      resolveHumanTaskTargets(resolution, human, participants(), ["agent-b"], 8)
    ).toEqual({ ok: true, targets: ["agent-b"] })
    expect(
      resolveHumanTaskTargets(resolution, human, participants(), ["human"], 8)
    ).toEqual({ ok: false, error: "task_target_not_agent" })
    expect(
      resolveHumanTaskTargets(
        resolution,
        human,
        {
          ...participants(),
          "agent-b": participant("agent-b", "agent", false),
        },
        ["agent-b"],
        8
      )
    ).toEqual({ ok: false, error: "task_target_not_in_room" })
    expect(
      resolveHumanTaskTargets(resolution, human, participants(), ["missing"], 8)
    ).toEqual({ ok: false, error: "task_target_not_in_room" })
  })

  it("lets a participating Agent extend the Task but rejects a forged sender", () => {
    const index = buildTaskProjectionIndex([request()], participants())
    const resolution = resolveTaskRequest(index, "task-T", participants())
    if (!resolution || resolution.ok === false) throw new Error("task missing")

    expect(
      resolveAgentTaskTargets(
        resolution,
        participants()["agent-a"],
        participants(),
        ["agent-b"],
        8
      )
    ).toEqual({ ok: true, targets: ["agent-b"] })
    expect(
      resolveAgentTaskTargets(
        resolution,
        participants()["agent-c"],
        participants(),
        ["agent-b"],
        8
      )
    ).toEqual({ ok: false, error: "task_target_mismatch" })
  })
})
