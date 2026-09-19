import type {
  TaskExecutionAvailability,
  TaskExecutionOutcome,
  TaskExecutionPhase,
} from "../room/types"

// #409: shared Browser + Room validation of the transient Task execution
// projection. It lives in common because both the Durable Object (ingest) and
// the browser (render) must agree on the exact same closed shape.

export const MAX_TASK_EXECUTION_QUEUED_COUNT = 64

export function isTaskExecutionPhase(
  value: unknown
): value is TaskExecutionPhase {
  return value === "running" || value === "interrupting" || value === "queued"
}

/**
 * #421: the closed shape rule for one Task execution projection, shared by the
 * Room's ingest validation and by any Browser-side check. A phase that claims
 * a running turn without one, or a QUEUED phase with nothing waiting, is
 * rejected rather than stored or rendered.
 */
export function isValidTaskExecutionShape(projection: {
  currentTurnSequence?: number
  phase?: TaskExecutionPhase
  queuedCount: number
  lastOutcome?: TaskExecutionOutcome
  availability?: TaskExecutionAvailability
}): boolean {
  if (projection.phase !== undefined && !isTaskExecutionPhase(projection.phase))
    return false
  if (projection.currentTurnSequence !== undefined) {
    // A current turn is running or being interrupted; "queued" describes the
    // absence of one.
    return projection.phase !== undefined && projection.phase !== "queued"
  }
  if (projection.phase === "queued") return projection.queuedCount > 0
  return projection.phase === undefined
}

export function isTaskExecutionOutcome(
  value: unknown
): value is TaskExecutionOutcome {
  return value === "interrupted"
}

export function isTaskExecutionAvailability(
  value: unknown
): value is TaskExecutionAvailability {
  return value === "session_lost"
}

/**
 * Human-facing label parts for one Task's transient execution. `label` is the
 * single primary state; `detail` carries the additive queue depth so
 * "Running" and "2 queued" can be shown together. There is deliberately no
 * combined enum: running + queued is a real state.
 */
export function taskExecutionLabel(projection: {
  currentTurnSequence?: number
  phase?: TaskExecutionPhase
  queuedCount: number
  lastOutcome?: TaskExecutionOutcome
  availability?: TaskExecutionAvailability
}): { label: string; detail?: string } {
  const queuedDetail = (queued: number): string =>
    queued === 1 ? "1 queued" : `${queued} queued`
  if (projection.availability === "session_lost")
    return { label: "Session lost" }
  if (projection.currentTurnSequence !== undefined) {
    const label =
      projection.phase === "interrupting" ? "Interrupting" : "Running"
    const queued = projection.queuedCount
    return {
      label,
      ...(queued > 0 ? { detail: queuedDetail(queued) } : {}),
    }
  }
  // #421: an explicit QUEUED phase means accepted work is waiting for an
  // execution lane (bounded cross-session concurrency, or a serial provider).
  // It is presented as waiting for capacity, never as a failed or silent Task.
  if (projection.phase === "queued") {
    return {
      label: "Queued",
      detail:
        projection.queuedCount > 0
          ? `waiting for an execution lane · ${queuedDetail(
              projection.queuedCount
            )}`
          : "waiting for an execution lane",
    }
  }
  if (projection.queuedCount > 0) {
    return { label: "Queued", detail: queuedDetail(projection.queuedCount) }
  }
  if (projection.lastOutcome === "interrupted") return { label: "Interrupted" }
  return { label: "" }
}
