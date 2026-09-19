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
  return value === "running" || value === "interrupting"
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
  if (projection.availability === "session_lost")
    return { label: "Session lost" }
  if (projection.currentTurnSequence !== undefined) {
    const label =
      projection.phase === "interrupting" ? "Interrupting" : "Running"
    const queued = projection.queuedCount
    return {
      label,
      ...(queued > 0
        ? { detail: queued === 1 ? "1 queued" : `${queued} queued` }
        : {}),
    }
  }
  if (projection.queuedCount > 0) {
    return {
      label: "Queued",
      detail:
        projection.queuedCount === 1
          ? "1 queued"
          : `${projection.queuedCount} queued`,
    }
  }
  if (projection.lastOutcome === "interrupted") return { label: "Interrupted" }
  return { label: "" }
}
