import type { AgentActivityState } from "../room/types"

// #409: the exact canonical Room turn an Agent activity belongs to. This is a
// shared Browser + Room validation rule, not a Durable Object implementation
// detail: the browser binds a Human click to it and RoomSession verifies the
// same value. It must therefore be a positive JavaScript-safe integer so every
// side compares the identical number.
export const MAX_AGENT_ACTIVITY_TURN_SEQUENCE = Number.MAX_SAFE_INTEGER

export function isAgentActivityTurnSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_AGENT_ACTIVITY_TURN_SEQUENCE
  )
}

export function agentActivityLabel(state: AgentActivityState): string {
  switch (state) {
    case "working":
      return "Working"
    case "thinking":
      return "Thinking"
    case "using_tools":
      return "Using tools"
    case "responding":
      return "Responding"
  }
}
