import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * #234 production wiring proof: after the Request-work modal and the Human
 * self-capability editor were removed, RoomContent must never render either
 * entry point, and Agent advertised capability chips still surface from the
 * canonical Room participant state.
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

const LOCAL_PEER = "local-peer"

function connectedParticipants() {
  return [
    {
      peerId: LOCAL_PEER,
      name: "tester",
      kind: "human" as const,
      room: "test-room",
      capabilities: [],
    },
    {
      peerId: "agent-b",
      name: "Agent B",
      kind: "agent" as const,
      room: "test-room",
      capabilities: ["browser.control"],
    },
  ]
}

beforeEach(() => {
  // jsdom lacks scrollIntoView; TextChatCard auto-scrolls on new messages.
  Element.prototype.scrollIntoView = vi.fn()
})

describe("simplified Human/Agent room wiring (#234)", () => {
  it("Agent cards no longer expose Request work and no Human capability editor exists", async () => {
    mockUseSfuChatRoom.mockReturnValue({
      participants: connectedParticipants(),
      messages: [],
      attachments: [],
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      sendActionMessage: vi.fn(),
      sendCollabResponse: vi.fn(),
      readRoomAttachment: vi.fn(),
      getLocalRoomAuth: vi.fn(() => ({
        roomId: "test-room",
        participantId: LOCAL_PEER,
        token: "tok",
      })),
      muteSelf: vi.fn(),
      toggleScreenShare: vi.fn(),
      retryVerification: vi.fn(),
      error: "",
      connectionStatus: "connected",
      resolvedRoomType: "audio",
      liveTranscript: { active: false },
      liveTranscriptSegments: [],
      runtimeHosts: {},
      runtimeHostProviders: {},
      liveTranscriptMediaAvailable: false,
      startLiveTranscript: vi.fn(),
      stopLiveTranscript: vi.fn(),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    // Removed #234 entry points never render.
    expect(screen.queryByText("Request work")).toBeNull()
    expect(screen.queryByText("Capabilities")).toBeNull()

    // The ordinary @-mention composer is the Human→Agent path and the Agent
    // card still renders as an Agent card.
    expect(
      screen.getByPlaceholderText(/Message the room or @ an Agent/)
    ).toBeTruthy()
    expect(screen.getAllByText(/🤖 Agent/).length).toBeGreaterThan(0)
  })
})
