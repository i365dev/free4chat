import { readFileSync } from "node:fs"

import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #228 production follow-up: the previous uniform min-height contract did not
 * make Human and Agent cards equal because Agent-only controls could still
 * grow the card. Normal RoomContent cards now share one fixed outer height;
 * compact/screen-share cards remain content-sized.
 *
 * jsdom cannot measure real layout, so this test pins both halves of the
 * implementation contract: the unique normal-card wrapper shape and the CSS
 * rule that fixes its direct UserCard child to 16rem. Production visual smoke
 * remains the final check.
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

  it(
    "normal-grid participant cards share one fixed outer-height contract regardless of kind",
    () => {
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

      // RoomContent gives exactly this wrapper to every NORMAL UserCard.
      const normalCardWrappers = Array.from(
        document.querySelectorAll("div.w-40.flex-none")
      )
      expect(normalCardWrappers.length).toBe(3)

      // UserCard still carries its old minimum as a harmless fallback, but the
      // stylesheet now pins the normal wrapper's direct card child to one real
      // fixed height so Agent-only controls cannot grow the outer card.
      const cards = Array.from(
        document.querySelectorAll("div.rounded-xl.border-gray-700")
      ).filter((el) => el.className.includes("min-h-[196px]"))
      expect(cards.length).toBe(3)

      const css = readFileSync(
        new URL("../styles/tailwind.css", import.meta.url),
        "utf8"
      )
      expect(css).toContain(".w-40.flex-none > div.rounded-xl.border-gray-700 {")
      expect(css).toContain("height: 16rem;")
      expect(css).toContain("min-height: 16rem;")

      // The grid stays top-aligned; no full-panel-height stretching returns.
      const grid = document.querySelector(".flex-wrap.items-start")
      expect(grid).toBeTruthy()
      expect(document.querySelector(".flex-wrap.items-stretch")).toBeNull()
      expect(document.querySelectorAll("[data-peer]").length).toBe(0)
    }
  )
})
