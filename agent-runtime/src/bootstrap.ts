export const RUNTIME_PACKAGE_NAME = "@i365dev/free4chat-agent"
export const RUNTIME_PACKAGE_VERSION = "0.4.0"

export const BUILT_IN_AGENT_IDS = [
  "hermes",
  "opencode",
  "codex",
  "claude",
  "pi",
  "deepseek-harness",
] as const

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[number]

export interface BootstrapInvocation {
  command: "npx"
  args: string[]
}

export function buildBootstrapInvocation(
  roomId: string,
  agent: BuiltInAgentId,
  name: string
): BootstrapInvocation {
  return {
    command: "npx",
    args: [
      "-y",
      `${RUNTIME_PACKAGE_NAME}@${RUNTIME_PACKAGE_VERSION}`,
      "join",
      "--room",
      roomId,
      "--agent",
      agent,
      "--name",
      name,
    ],
  }
}
