import type { CollabEvent, RoomMessage, RoomParticipant } from "../room/types"

export type TaskProjectionIndex = {
  tasks: Map<string, TaskProjectionTask>
}

type TaskProjectionTask = {
  request: CollabEvent
  participatingAgentIds: Set<string>
  agentsBySequence: Map<number, Set<string>>
}

export type TaskRequestResolution = {
  ok: true
  requestId: string
  request: CollabEvent
  primaryAgentParticipantId: string
  agentParticipantIds: string[]
}

export type TaskTargetResolution =
  | { ok: true; targets: string[] }
  | { ok: false; error: string }

export type TaskEventProjection =
  | { kind: "ordinary" }
  | { kind: "task"; visible: false }
  | {
      kind: "task"
      visible: true
      scopeId: string
      addressed: boolean
    }

function taskRequestIdFor(message: RoomMessage): string | undefined {
  return message.taskRequestId ?? message.collab?.requestId
}

function connectedAgent(
  participants: Record<string, RoomParticipant>,
  participantId: string
): boolean {
  const participant = participants[participantId]
  return participant?.kind === "agent" && participant.connected
}

function addAgentEndpoint(
  task: TaskProjectionTask,
  participants: Record<string, RoomParticipant>,
  participantId: string
): void {
  if (participants[participantId]?.kind === "agent")
    task.participatingAgentIds.add(participantId)
}

/**
 * Derives bounded Task participation from the retained canonical Room log.
 * The index is intentionally ephemeral: the message ring remains the only
 * source of truth and a DO restart reconstructs the same decisions.
 */
export function buildTaskProjectionIndex(
  messages: readonly RoomMessage[],
  participants: Record<string, RoomParticipant>
): TaskProjectionIndex {
  const tasks = new Map<string, TaskProjectionTask>()
  const ordered = [...messages].sort(
    (left, right) => left.sequence - right.sequence
  )

  for (const message of ordered) {
    const collab = message.collab
    if (collab?.kind === "request" && !tasks.has(collab.requestId)) {
      const task: TaskProjectionTask = {
        request: collab,
        participatingAgentIds: new Set(),
        agentsBySequence: new Map(),
      }
      addAgentEndpoint(task, participants, collab.fromParticipantId)
      addAgentEndpoint(task, participants, collab.targetParticipantId)
      task.agentsBySequence.set(
        message.sequence,
        new Set(task.participatingAgentIds)
      )
      tasks.set(collab.requestId, task)
      continue
    }

    const requestId = taskRequestIdFor(message)
    if (!requestId) continue
    const task = tasks.get(requestId)
    if (!task) continue

    const visibleAgents = new Set(task.participatingAgentIds)
    const sender = participants[message.peerId]
    const senderMayExtendTask =
      sender?.kind === "human" ||
      (sender?.kind === "agent" && task.participatingAgentIds.has(sender.id))

    // Only validated task text can extend participation. The live Room path
    // rejects stale/non-Agent targets before persistence; reconstruction uses
    // the same current roster shape and fails closed for anything else.
    if (message.taskRequestId && senderMayExtendTask) {
      for (const targetId of message.targets ?? []) {
        if (participants[targetId]?.kind !== "agent") continue
        task.participatingAgentIds.add(targetId)
        visibleAgents.add(targetId)
      }
    }
    task.agentsBySequence.set(message.sequence, visibleAgents)
  }

  return { tasks }
}

export function resolveTaskRequest(
  index: TaskProjectionIndex,
  rawRequestId: unknown,
  participants: Record<string, RoomParticipant>
): TaskRequestResolution | { ok: false; error: string } {
  if (typeof rawRequestId !== "string")
    return { ok: false, error: "invalid_task_request" }
  const requestId = rawRequestId.trim()
  if (!requestId) return { ok: false, error: "invalid_task_request" }
  const task = index.tasks.get(requestId)
  if (!task) return { ok: false, error: "unknown_task_request" }

  const agentParticipantIds = [...task.participatingAgentIds].filter((id) =>
    connectedAgent(participants, id)
  )
  if (agentParticipantIds.length === 0)
    return { ok: false, error: "task_target_not_in_room" }

  const primaryAgentParticipantId = connectedAgent(
    participants,
    task.request.targetParticipantId
  )
    ? task.request.targetParticipantId
    : connectedAgent(participants, task.request.fromParticipantId)
    ? task.request.fromParticipantId
    : agentParticipantIds[0]

  return {
    ok: true,
    requestId,
    request: task.request,
    primaryAgentParticipantId,
    agentParticipantIds,
  }
}

function normalizedExplicitTargets(
  rawTargets: unknown,
  maxTargets: number
): string[] | { error: string } | undefined {
  if (rawTargets === undefined) return undefined
  if (
    !Array.isArray(rawTargets) ||
    rawTargets.some((id) => typeof id !== "string")
  )
    return { error: "invalid_task_targets" }
  const targets = [...new Set(rawTargets.map((id) => id.trim()))]
  if (targets.some((id) => !id)) return { error: "invalid_task_targets" }
  if (targets.length > maxTargets) return { error: "too_many_task_targets" }
  return targets
}

export function resolveHumanTaskTargets(
  resolution: TaskRequestResolution,
  sender: RoomParticipant,
  participants: Record<string, RoomParticipant>,
  rawTargets: unknown,
  maxTargets: number
): TaskTargetResolution {
  if (sender.kind !== "human" || !sender.connected)
    return { ok: false, error: "task_sender_not_human" }
  const targets = normalizedExplicitTargets(rawTargets, maxTargets)
  if (targets && !Array.isArray(targets))
    return { ok: false, error: targets.error }
  const validTargets = targets as string[] | undefined
  if (!validTargets || validTargets.length === 0)
    return { ok: true, targets: [resolution.primaryAgentParticipantId] }

  for (const targetId of validTargets) {
    const target = participants[targetId]
    if (!target || !target.connected)
      return { ok: false, error: "task_target_not_in_room" }
    if (target.kind !== "agent")
      return { ok: false, error: "task_target_not_agent" }
  }
  return { ok: true, targets: validTargets }
}

export function resolveAgentTaskTargets(
  resolution: TaskRequestResolution,
  sender: RoomParticipant,
  participants: Record<string, RoomParticipant>,
  rawTargets: unknown,
  maxTargets: number
): TaskTargetResolution {
  if (
    sender.kind !== "agent" ||
    !sender.connected ||
    !resolution.agentParticipantIds.includes(sender.id)
  )
    return { ok: false, error: "task_target_mismatch" }
  const targets = normalizedExplicitTargets(rawTargets, maxTargets)
  if (targets && !Array.isArray(targets))
    return { ok: false, error: targets.error }
  const validTargets = targets as string[] | undefined
  if (!validTargets || validTargets.length === 0)
    return { ok: true, targets: [] }

  for (const targetId of validTargets) {
    if (targetId === sender.id) continue
    const target = participants[targetId]
    if (!target || !target.connected)
      return { ok: false, error: "task_target_not_in_room" }
  }
  return {
    ok: true,
    targets: validTargets.filter((id) => id !== sender.id),
  }
}

/**
 * Returns an explicit decision for Task events. `historical=true` is used by
 * bounded context reads: an Agent that has since joined may inspect retained
 * Task context, while live event delivery remains sequence-aware.
 */
export function projectTaskEvent(
  index: TaskProjectionIndex,
  message: RoomMessage,
  participantId: string,
  historical = false
): TaskEventProjection {
  const requestId = taskRequestIdFor(message)
  if (!requestId) return { kind: "ordinary" }
  const task = index.tasks.get(requestId)
  // A structured lifecycle envelope without a retained request is still the
  // legacy ordinary collaboration projection. Explicit task text carries
  // taskRequestId, so an orphaned Task message remains fail-closed instead of
  // falling back to Room context.
  if (!task && message.taskRequestId === undefined) return { kind: "ordinary" }
  if (!task) return { kind: "task", visible: false }

  const participantSet = historical
    ? task.participatingAgentIds
    : task.agentsBySequence.get(message.sequence) ?? new Set<string>()
  if (!participantSet.has(participantId))
    return { kind: "task", visible: false }
  return {
    kind: "task",
    visible: true,
    scopeId: `task:${requestId}`,
    addressed: message.targets?.includes(participantId) === true,
  }
}
