import type { AgentAdapterName, HarnessAdapter } from "../types.js"
import { ClaudeAdapter } from "./claude.js"
import { CodexAdapter } from "./codex.js"
import { HermesAdapter } from "./hermes.js"
import { PiAdapter } from "./pi.js"

export function createHarnessAdapter(name: AgentAdapterName): HarnessAdapter {
  switch (name) {
    case "hermes":
      return new HermesAdapter()
    case "codex":
      return new CodexAdapter()
    case "claude":
      return new ClaudeAdapter()
    case "pi":
      return new PiAdapter()
  }
}
