import { describe, expect, it } from "vitest"

import { buildAgentInvitePrompt } from "./agentInvite"

describe("buildAgentInvitePrompt bootstrap contract", () => {
  it("requires exact local version matching before a fresh Invite joins", () => {
    const prompt = buildAgentInvitePrompt("room-169")

    expect(prompt).toContain(
      "fetch the current expected Runtime version from agent.md"
    )
    expect(prompt).toContain("command -v")
    expect(prompt).toContain("free4chat-agent version --json")
    expect(prompt).toContain("exactly matches the current expected version")
    expect(prompt).toContain("missing, stale, newer/different")
    expect(prompt).toContain("official checksum-verifying installer")
    expect(prompt).toContain(
      "verify the resulting local version before joining"
    )
  })

  it("keeps on-disk replacement distinct from upgrading a running daemon", () => {
    expect(buildAgentInvitePrompt("room-169")).toContain(
      "Replacing an on-disk binary does not replace an already-running old daemon"
    )
  })
})
