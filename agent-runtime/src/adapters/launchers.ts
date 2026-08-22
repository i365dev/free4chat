import type { AgentLauncher } from "../types.js"

const builtInLaunchers: AgentLauncher[] = [
  {
    id: "hermes",
    displayName: "Hermes",
    command: "hermes",
    args: ["acp"],
    maturity: "native",
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    args: ["acp"],
    maturity: "native",
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.6.2"],
    maturity: "bridge",
    notes:
      "Official ACP bridge for Codex; pin or install it locally for offline use.",
  },
  {
    id: "claude",
    displayName: "Claude",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
    maturity: "bridge",
    notes: "ACP bridge maintained by the Agent Client Protocol project.",
  },
  {
    id: "pi",
    displayName: "Pi",
    command: "npx",
    args: ["-y", "pi-acp@0.0.33"],
    maturity: "bridge",
    notes: "ACP bridge listed by the official ACP registry.",
  },
  {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    command: "pnpm",
    args: ["run", "demo:acp"],
    maturity: "preview",
    notes:
      "Developer-preview automation ACP. Set FREE4CHAT_DEEPSEEK_REPO to its checkout or use a custom launcher.",
  },
]

export function listLaunchers(): AgentLauncher[] {
  return builtInLaunchers.map((launcher) => ({
    ...launcher,
    args: [...launcher.args],
  }))
}

export function getLauncher(id: string): AgentLauncher {
  const launcher = builtInLaunchers.find((candidate) => candidate.id === id)
  if (!launcher) throw new Error(`Unknown ACP launcher: ${id}`)
  if (id === "deepseek-harness") {
    const repo = process.env.FREE4CHAT_DEEPSEEK_REPO
    if (!repo)
      throw new Error(
        "DeepSeek Harness is preview-only; set FREE4CHAT_DEEPSEEK_REPO or use --agent-command"
      )
    return { ...launcher, args: ["--dir", repo, ...launcher.args] }
  }
  return { ...launcher, args: [...launcher.args] }
}

export function customLauncher(command: string, args: string[]): AgentLauncher {
  if (!command.trim()) throw new Error("ACP agent command cannot be empty")
  return {
    id: "custom",
    displayName: "Custom ACP Agent",
    command,
    args: [...args],
    maturity: "preview",
  }
}
