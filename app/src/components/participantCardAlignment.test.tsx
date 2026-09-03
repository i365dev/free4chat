import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #228 participant-card visual consistency: in the NORMAL participant grid,
 * every UserCard root carries the SAME uniform min-height contract, so
 * Agent-only controls (Request work + Voice) live inside a shared reserved
 * card height instead of stretching Agent cards taller than Human cards.
 * jsdom cannot measure layout; this pins the class contract that produces
 * equal heights (uniform min-height on every normal card root). Visual
 * confirmation happens in the production regression pass.
 */

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))
vi.mock("../hooks/useTurnstile", () => ({
  useTurnstile: () => ({
    containerRef: { current: null },
    requestToken: vi.fn(),
  }),
}))

import RoomContent from "./RoomContent"

const LOCAL = "human-h"

function hookReturn(participants: Array<Record<string, unknown>>) {
  return {
    participants,
    messages: [],
    getLocalRoomAuth: () => ({
      roomId: "test-room",
      participantId: LOCAL,
      token: "tok",
    }),
    sendTextMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    sendActionMessage: vi.fn(),
    sendCollabRequest: vi.fn(() => ""),
    sendCollabResponse: vi.fn(),
    sendCollabResult: vi.fn(),
    updateHumanCapabilities: vi.fn(),
    readRoomAttachment: vi.fn(),
    muteSelf: vi.fn(),
    toggleScreenShare: vi.fn(),
    retryVerification: vi.fn(),
    error: "",
    connectionStatus: "connected",
    resolvedRoomType: "audio" as const,
    meetingNotes: { active: false },
    meetingNotesMediaAvailable: true,
    startMeetingNotes: vi.fn(),
    stopMeetingNotes: vi.fn(),
    agentVoice: {},
    agentVoiceMediaAvailable: true,
    startVoiceReply: vi.fn(),
    stopVoiceReply: vi.fn(),
    localParticipantId: LOCAL,
  }
}

describe("participant card equal-height contract (#228)", () => {
  afterEach(cleanup)

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("normal-grid participant cards share the stretch/height contract regardless of kind", () => {
    mockUseSfuChatRoom.mockReturnValue(
      hookReturn([
        { peerId: LOCAL, name: "Hannah", kind: "human", room: "test-room" },
        { peerId: "agent-pi", name: "Pi", kind: "agent", room: "test-room" },
        {
          peerId: "human-r",
          name: "Remote",
          kind: "human",
          room: "test-room",
        },
      ])
    )
    render(
      <RoomContent roomName="test-room" nickName="Hannah" roomType="audio" />
    )

    // Every normal-grid participant card root carries the SAME uniform
    // min-height — Human self, Agents with controls, remote Humans.
    const cards = Array.from(
      document.querySelectorAll("div.rounded-xl.border-gray-700")
    ).filter((el) => el.className.includes("min-h-[196px]"))
    expect(cards.length).toBe(3)

    // The grid top-aligns rows; no full-panel-height stretching remains.
    const grid = document.querySelector(".flex-wrap.items-start")
    expect(grid).toBeTruthy()
    expect(document.querySelector(".flex-wrap.items-stretch")).toBeNull()
    expect(document.querySelectorAll("[data-peer]").length).toBe(0)
  })
})
