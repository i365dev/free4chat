import assert from "node:assert/strict"
import { describe, expect, it } from "vitest"
import {
  clearVoiceReplyIfParticipantDeparting,
  isAgentAuthorizedForVoiceReply,
  NO_VOICE_REPLY,
  resolveAgentPurposePermission,
  startVoiceReply,
} from "./meetingNotesAuth"

const GRANTED = startVoiceReply("agent-1", 1000)

describe("voiceReply grant (#83)", () => {
  it("denies by default and only authorizes the named agent", () => {
    expect(isAgentAuthorizedForVoiceReply(NO_VOICE_REPLY, "agent-1")).toBe(false)
    expect(isAgentAuthorizedForVoiceReply(GRANTED, "agent-1")).toBe(true)
    expect(isAgentAuthorizedForVoiceReply(GRANTED, "agent-2")).toBe(false)
    const stopped = clearVoiceReplyIfParticipantDeparting(GRANTED, "agent-1")
    expect(stopped).toEqual(NO_VOICE_REPLY)
    expect(clearVoiceReplyIfParticipantDeparting(GRANTED, "other")).toBe(GRANTED)
  })
})

describe("agent purpose direction matrix (#83)", () => {
  it("fails closed on missing/unknown purpose", () => {
    for (const purpose of [undefined, "", "chat"]) {
      expect(
        resolveAgentPurposePermission({ purpose, wantsLocalPublish: false, wantsRemoteSubscribe: true, involvesVideo: false })
      ).toEqual({ ok: false, error: "agent_media_purpose_required" })
    }
  })
  it("meeting-notes permits only remote subscribe", () => {
    expect(resolveAgentPurposePermission({ purpose: "meeting-notes", wantsLocalPublish: false, wantsRemoteSubscribe: true, involvesVideo: false }).ok).toBe(true)
    expect(resolveAgentPurposePermission({ purpose: "meeting-notes", wantsLocalPublish: true, wantsRemoteSubscribe: false, involvesVideo: false })).toEqual({ ok: false, error: "agent_media_direction_forbidden" })
  })
  it("voice-reply permits only local publish", () => {
    expect(resolveAgentPurposePermission({ purpose: "voice-reply", wantsLocalPublish: true, wantsRemoteSubscribe: false, involvesVideo: false }).ok).toBe(true)
    expect(resolveAgentPurposePermission({ purpose: "voice-reply", wantsLocalPublish: false, wantsRemoteSubscribe: true, involvesVideo: false })).toEqual({ ok: false, error: "agent_media_direction_forbidden" })
  })
  it("video is always denied", () => {
    for (const purpose of ["meeting-notes", "voice-reply"]) {
      expect(resolveAgentPurposePermission({ purpose, wantsLocalPublish: false, wantsRemoteSubscribe: false, involvesVideo: true }).error).toBe("agent_video_forbidden")
    }
  })
})
