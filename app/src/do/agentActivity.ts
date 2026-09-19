import type { AgentActivityProjection, AgentActivityState } from "../room/types"

export const AGENT_ACTIVITY_STATES = [
  "working",
  "thinking",
  "using_tools",
  "responding",
] as const satisfies readonly AgentActivityState[]

export const MAX_AGENT_ACTIVITY_SCOPE_LENGTH = 128
const TASK_SCOPE_PATTERN = /^task:[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/

export function isAgentActivityState(
  value: unknown
): value is AgentActivityState {
  return (
    typeof value === "string" &&
    (AGENT_ACTIVITY_STATES as readonly string[]).includes(value)
  )
}

export function isAgentActivityScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_ACTIVITY_SCOPE_LENGTH &&
    (value === "room" || TASK_SCOPE_PATTERN.test(value))
  )
}

// #409: the exact canonical Room turn an activity belongs to. It must be a
// positive JavaScript-safe integer so the browser, the Room, and the Runtime
// compare the identical value; anything else cannot identify one turn.
export const MAX_AGENT_ACTIVITY_TURN_SEQUENCE = Number.MAX_SAFE_INTEGER

export function isAgentActivityTurnSequence(
  value: unknown
): value is AgentActivityProjection["turnSequence"] {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_AGENT_ACTIVITY_TURN_SEQUENCE
  )
}

export function agentActivityKey(agentParticipantId: string, scopeId: string) {
  return `${agentParticipantId}\u0000${scopeId}`
}

export function findAgentTurnActivity(
  activities: readonly AgentActivityProjection[] | undefined,
  agentParticipantId: string,
  scopeId: string,
  turnSequence: unknown
): AgentActivityProjection | undefined {
  if (!isAgentActivityTurnSequence(turnSequence)) return undefined
  return (activities ?? []).find(
    (activity) =>
      activity.agentParticipantId === agentParticipantId &&
      activity.scopeId === scopeId &&
      activity.turnSequence === turnSequence
  )
}
