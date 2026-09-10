import type { AgentActivityState } from "../room/types"

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
