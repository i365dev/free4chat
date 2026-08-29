import { describe, expect, it } from "vitest"

import { buildAgentInvitePrompt } from "./agentInvite"

describe("buildAgentInvitePrompt bootstrap contract", () => {
  it("requires exact local version matching before a fresh Invite joins", () => {
    const prompt = buildAgentInvitePrompt("room-169")

    expect(prompt).toContain(
      "fetch the current expected Runtime version from agent.md"
    )
    expect(prompt).toContain("command -v")
    expect(prompt).toContain("runtime_bin")
    expect(prompt).toContain('"$runtime_bin" version --json')
    expect(prompt).toContain('fall back to "$runtime_bin" doctor --json')
    expect(prompt).toContain("Never re-run command -v")
    expect(prompt).toContain(
      "FREE4CHAT_AGENT_INSTALL_DIR, then XDG_BIN_HOME, then $HOME/.local/bin"
    )
    expect(prompt).toContain(
      "use runtime_bin for readiness, diagnostics, and join"
    )
    expect(prompt).toContain("exactly matches the current expected version")
    expect(prompt).toContain("missing, stale, newer/different")
    expect(prompt).toContain("official checksum-verifying installer")
    expect(prompt).toContain(
      "verify that exact executable with the same compatible probe before joining"
    )
  })

  it("keeps on-disk replacement distinct from upgrading a running daemon", () => {
    expect(buildAgentInvitePrompt("room-169")).toContain(
      "Replacing an on-disk binary does not replace an already-running old daemon"
    )
  })
})
