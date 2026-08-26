import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * #113/#119 production wiring proof: RoomContent must derive the Human
 * self-only capability editor entry from the canonical Room participant
 * state (not local editor state), pass the safe public participant id, and
 * keep the editor away from remote Humans and Agent cards.
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
      capabilities: ["review.code"],
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

describe("Human capability advertisement wiring (#113/#115/#119)", () => {
  it("self Human card shows Capabilities; Agent card shows Request work only; Save sends full list via hook", async () => {
    const sendCollabRequest = vi.fn(() => "")
    const updateHumanCapabilities = vi.fn()
    mockUseSfuChatRoom.mockReturnValue({
      participants: connectedParticipants(),
      messages: [],
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      sendActionMessage: vi.fn(),
      sendCollabRequest,
      sendCollabResponse: vi.fn(),
      updateHumanCapabilities,
      getLocalRoomAuth: vi.fn(() => ({
        roomId: "test-room",
        participantId: LOCAL_PEER,
        token: "tok",
      })),
      readRoomAttachment: vi.fn(),
      muteSelf: vi.fn(),
      toggleScreenShare: vi.fn(),
      retryVerification: vi.fn(),
      error: "",
      connectionStatus: "connected",
      resolvedRoomType: "audio",
      meetingNotes: { active: false },
      meetingNotesMediaAvailable: true,
      startMeetingNotes: vi.fn(),
      stopMeetingNotes: vi.fn(),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />,
    )

    // Self Human: Capabilities entry present; no Request work on own card.
    expect(screen.getByText("Capabilities")).toBeTruthy()

    // Remote Agent card: Request work present.
    const requestButtons = screen.getAllByText(/Request work/)
    expect(requestButtons.length).toBe(1)

    // Open the editor via the self card and save a replacement list.
    fireEvent.click(screen.getByText("Capabilities"))
    const input = screen.getByPlaceholderText("Add capability…")
    fireEvent.change(input, { target: { value: "judgment.product" } })
    fireEvent.click(screen.getByText("Add"))
    fireEvent.click(screen.getByTestId("save-capabilities"))
    expect(updateHumanCapabilities).toHaveBeenCalledTimes(1)
    // Editor initialized from canonical Room state (["review.code"]) and
    // Save sends the FULL replacement list including the added token.
    expect(updateHumanCapabilities).toHaveBeenCalledWith([
      "review.code",
      "judgment.product",
    ])
  })
})
