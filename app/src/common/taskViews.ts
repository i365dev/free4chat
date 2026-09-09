import type { Message } from "./types"

export type TaskStatus = "Starting" | "Working" | "Completed" | "Failed"

export interface TaskProjection {
  requestId: string
  title: string
  createdByParticipantId: string
  targetParticipantId: string
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
    if (collab)
      projection.status = applyTaskLifecycle(projection.status, collab.kind)
  }

  return [...projections.values()]
}

export function roomMessagesForView(messages: Message[]): Message[] {
  return messages.filter((message) => !isTaskCorrelatedMessage(message))
}
