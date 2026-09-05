import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #228/#234 participant-card visual consistency: in the NORMAL participant
 * band, every UserCard root carries the same compact presentation contract, so
 * Agent-only controls (Voice) live inside the same bounded card surface as
 * Human presence. jsdom cannot measure layout; this pins the semantic card
 * marker and grid contract. Visual confirmation happens in the production
 * regression pass.
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
    sendCollabResponse: vi.fn(),
    sendCollabResult: vi.fn(),
    readRoomAttachment: vi.fn(),
    muteSelf: vi.fn(),
    toggleScreenShare: vi.fn(),
    retryVerification: vi.fn(),
    error: "",
    connectionStatus: "connected",
    resolvedRoomType: "audio" as const,
    agentVoiceMediaAvailable: true,
    localParticipantId: LOCAL,
  }
}

describe("participant card presentation contract (#228)", () => {
  afterEach(cleanup)

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("normal-grid participant cards share the bounded presentation contract regardless of kind", () => {
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

    // Every normal-grid participant card root carries the same semantic marker
    // — Human self, Agents with controls, and remote Humans.
    const cards = Array.from(
      document.querySelectorAll('[data-testid="participant-card"]')
    )
    expect(cards.length).toBe(3)
    expect(
      cards.every((card) => card.className.includes("participant-card"))
    ).toBe(true)

    // A normal Room keeps presence in a bounded band; chat owns the remaining
    // viewport rather than sharing a full-height split panel.
    const grid = document.querySelector(".room-participants-grid")
    expect(grid).toBeTruthy()
    expect(grid).toHaveClass("room-participants-grid--band")
    expect(grid).toHaveClass("room-participants-grid--node-band")
    expect(
      cards.every((card) => card.className.includes("participant-card--node"))
    ).toBe(true)
    expect(document.querySelector(".items-stretch")).toBeNull()
  })
})
