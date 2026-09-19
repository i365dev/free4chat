import type { AgentActivityState } from "../room/types"

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

export function agentActivityKey(agentParticipantId: string, scopeId: string) {
  return `${agentParticipantId}\u0000${scopeId}`
}
