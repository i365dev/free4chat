import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * #305 production wiring proof: the old Request-work/capability-editor
 * controls remain absent while the small Start-task entry point is available
 * on a connected Agent card.
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

describe("simplified Human/Agent room wiring (#305)", () => {
  it("exposes Start task on a connected Agent without restoring old controls", async () => {
    const sendCollabRequest = vi.fn(() => true)
    mockUseSfuChatRoom.mockReturnValue({
      participants: connectedParticipants(),
      messages: [],
      attachments: [],
      sendTextMessage: vi.fn(),
      sendFileMessage: vi.fn(),
      sendActionMessage: vi.fn(),
      sendCollabRequest,
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

    expect(
      screen.getByRole("button", { name: "Start task with Agent B" })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Start task with Agent B" })
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("What should this Agent do?"), {
      target: { value: "Review TASK_T_MARKER" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(sendCollabRequest).toHaveBeenCalledWith(
      "agent-b",
      "Review TASK_T_MARKER"
    )

    // The ordinary @-mention composer remains available and the Agent card
    // still renders as an Agent card.
    expect(
      screen.getByPlaceholderText(/Message the room or @ an Agent/)
    ).toBeTruthy()
    expect(screen.getAllByText(/🤖 Agent/).length).toBeGreaterThan(0)
  })
})
