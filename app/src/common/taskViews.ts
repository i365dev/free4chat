import type { Message, UserInfo } from "./types"

export type TaskStatus = "Starting" | "Working" | "Completed" | "Failed"

export interface TaskProjection {
  requestId: string
  title: string
  createdByParticipantId: string
  targetParticipantId: string
  /** Retained Task endpoint ids, filtered to connected Agents at render time. */
  participatingAgentIds: string[]
  status: TaskStatus
  messages: Message[]
}

export function isTaskCorrelatedMessage(message: Message): boolean {
  return Boolean(message.taskRequestId || message.collab?.requestId)
}

function applyTaskLifecycle(
  current: TaskStatus,
  kind: NonNullable<Message["collab"]>["kind"]
): TaskStatus {
  switch (kind) {
    case "accepted":
      return "Working"
    case "completed":
      return "Completed"
    case "declined":
    case "failed":
      return "Failed"
    default:
      return current
  }
}

function addParticipantId(ids: Set<string>, value: unknown): void {
  if (typeof value !== "string") return
  const participantId = value.trim()
  if (participantId) ids.add(participantId)
}

function addTaskParticipants(ids: Set<string>, message: Message): void {
  const collab = message.collab
  if (collab) {
    addParticipantId(ids, collab.fromParticipantId)
    addParticipantId(ids, collab.targetParticipantId)
  }

  // Task text uses the same structured targets that the Room authorization
  // projection uses. Keep the ids here and resolve their current presence at
  // render time; a departed Agent must remain part of Task history so a
  // returning/secondary Agent can make the Task available again.
  if (message.taskRequestId)
    for (const targetId of message.targets ?? [])
      addParticipantId(ids, targetId)
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "Completed" || status === "Failed"
}

export function taskHasConnectedAgent(
  task: Pick<TaskProjection, "participatingAgentIds">,
  participants: Pick<UserInfo, "peerId" | "kind">[]
): boolean {
  return task.participatingAgentIds.some((participantId) =>
    participants.some(
      (participant) =>
        participant.peerId === participantId && participant.kind === "agent"
    )
  )
}

/**
 * Derives bounded Task views from the canonical retained Room message log.
 * This is presentation only: the Room collaboration request remains the
 * identity and authority, and no browser task history is created.
 */
export function buildTaskProjections(messages: Message[]): TaskProjection[] {
  const projections = new Map<string, TaskProjection>()

  for (const message of messages) {
    const collab = message.collab
    if (collab?.kind === "request") {
      projections.set(collab.requestId, {
        requestId: collab.requestId,
        title: collab.summary ?? "Untitled task",
        createdByParticipantId: collab.fromParticipantId,
        targetParticipantId: collab.targetParticipantId,
        participatingAgentIds: [
          ...new Set(
            [collab.fromParticipantId, collab.targetParticipantId].filter(
              Boolean
            )
          ),
        ],
        status: "Starting",
        messages: [message],
      })
      continue
    }

    const requestId = message.taskRequestId ?? collab?.requestId
    if (!requestId) continue
    const projection = projections.get(requestId)
    if (!projection) continue
    projection.messages.push(message)
    const participants = new Set(projection.participatingAgentIds)
    addTaskParticipants(participants, message)
    projection.participatingAgentIds = [...participants]
    if (collab)
      projection.status = applyTaskLifecycle(projection.status, collab.kind)
  }

  return [...projections.values()]
}

export function roomMessagesForView(messages: Message[]): Message[] {
  const retainedRequestIds = new Set(
    messages
      .filter((message) => message.collab?.kind === "request")
      .map((message) => message.collab!.requestId)
  )
  return messages.filter((message) => {
    const requestId = message.taskRequestId ?? message.collab?.requestId
    return !requestId || !retainedRequestIds.has(requestId)
  })
}
