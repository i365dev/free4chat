import { describe, expect, it } from "vitest"

import {
  isAgentAuthorizedForVoice,
  resolveAgentPurposePermission,
} from "./meetingNotesAuth"

describe("Agent Voice authorization", () => {
  it("allows two independently enabled Agents and denies a muted peer", () => {
    const grants = {
      "agent-1": { enabled: true as const, enabledAt: 1000 },
      "agent-2": { enabled: true as const, enabledAt: 2000 },
    }
    expect(isAgentAuthorizedForVoice(grants, "agent-1")).toBe(true)
    expect(isAgentAuthorizedForVoice(grants, "agent-2")).toBe(true)
    expect(isAgentAuthorizedForVoice(grants, "agent-3")).toBe(false)
  })
})

describe("agent purpose direction matrix", () => {
  it("allows voice local publication and never Human-audio subscription", () => {
    expect(
      resolveAgentPurposePermission({
        purpose: "voice-reply",
        wantsLocalPublish: true,
        wantsRemoteSubscribe: false,
        involvesVideo: false,
      })
    ).toEqual({ ok: true })
    expect(
      resolveAgentPurposePermission({
        purpose: "voice-reply",
        wantsLocalPublish: false,
        wantsRemoteSubscribe: true,
        involvesVideo: false,
      })
    ).toEqual({ ok: false, error: "agent_media_direction_forbidden" })
  })
})
