import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #121 production wiring proof: RoomContent -> TextChatCard renders
 * lifecycle-derived Human terminal controls from CANONICAL messages and the
 * submit path reaches the hook's sendCollabResult with exact values.
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

import type { Message } from "@common/types"

import RoomContent from "./RoomContent"

const LOCAL_HUMAN = "human-h"

function collabMessage(
  requestId: string,
  kind: "request" | "accepted" | "declined" | "completed" | "failed",
  from: string,
): Message {
  return {
    peerId: from,
    name:
      from === "agent-a" ? "Agent A" : from === LOCAL_HUMAN ? "Hannah" : from,
    kind: from.startsWith("human") ? "human" : "agent",
    type: "action",
    actionType: "collab",
    sequence: 1,
    collab: {
      requestId,
      kind,
      fromParticipantId: from,
      targetParticipantId: kind === "request" ? LOCAL_HUMAN : "agent-a",
      summary: kind === "request" ? "Please review the UX." : "done",
    },
  }
}

function hookReturn(
  messages: Message[],
  sendCollabResult: ReturnType<typeof vi.fn>,
) {
  return {
    participants: [
      {
        peerId: LOCAL_HUMAN,
        name: "Hannah",
        kind: "human" as const,
        room: "test-room",
      },
    ],
    messages,
    getLocalRoomAuth: () => ({
      roomId: "test-room",
      participantId: LOCAL_HUMAN,
      token: "tok",
    }),
    sendCollabResult,
    readRoomAttachment: vi.fn(),
    sendTextMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    sendActionMessage: vi.fn(),
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
  }
}

describe("Human terminal result wiring (#121)", () => {
  let sendCollabResult: ReturnType<typeof vi.fn>

  afterEach(cleanup)

  beforeEach(() => {
    // jsdom lacks scrollIntoView; TextChatCard auto-scrolls on new messages.
    Element.prototype.scrollIntoView = vi.fn()
    sendCollabResult = vi.fn()
  })

  function renderWith(messages: Message[]) {
    mockUseSfuChatRoom.mockReturnValue(hookReturn(messages, sendCollabResult))
    render(<RoomContent roomName="room" nickName="Hannah" roomType="audio" />)
  }

  it("before Accept only response controls show (no terminal controls)", () => {
    renderWith([collabMessage("r1", "request", "agent-a")])
    expect(screen.getByText("Accept")).toBeTruthy()
    expect(screen.queryByText("Mark complete")).toBeNull()
    expect(screen.queryByText("Mark failed")).toBeNull()
  })

  it("after canonical accepted: Mark complete/failed appear wired to the production callback", () => {
    renderWith([
      collabMessage("r1", "request", "agent-a"),
      collabMessage("r1", "accepted", LOCAL_HUMAN),
    ])
    expect(screen.queryByText("Accept")).toBeNull()
    expect(screen.getByText("Mark complete")).toBeTruthy()
    expect(screen.getByText("Mark failed")).toBeTruthy()

    // Clicking Mark failed opens the composer; fill the note and submit.
    fireEvent.click(screen.getByText("Mark failed"))
    const field = screen.getByPlaceholderText("Why did this fail?")
    fireEvent.change(field, {
      target: { value: "  Could not verify: login page broken.  " },
    })
    fireEvent.click(screen.getByTestId("send-collab-result-failed"))
    expect(sendCollabResult).toHaveBeenCalledWith(
      "r1",
      "failed",
      "Could not verify: login page broken.",
    )
  })

  it("terminal controls disappear once a canonical completed exists; lifecycle card remains", () => {
    renderWith([
      collabMessage("r1", "request", "agent-a"),
      collabMessage("r1", "accepted", LOCAL_HUMAN),
      { ...collabMessage("r1", "completed", LOCAL_HUMAN), name: "Hannah" },
    ])
    expect(screen.queryByText("Mark complete")).toBeNull()
    expect(screen.queryByText("Mark failed")).toBeNull()
    expect(screen.getByText(/Hannah completed the request/)).toBeTruthy()
  })

  it("requests targeting another Human or between Agents show no local terminal controls", () => {
    const cases: Message[][] = []
    const otherHuman = collabMessage("r3", "request", "agent-a")
    if (otherHuman.collab) otherHuman.collab.targetParticipantId = "human-OTHER"
    cases.push([otherHuman])
    const a2aRequest = collabMessage("r4", "request", "agent-b")
    if (a2aRequest.collab) {
      a2aRequest.collab.targetParticipantId = "agent-c"
      a2aRequest.collab.fromParticipantId = "agent-b"
    }
    cases.push([a2aRequest])
    for (const messages of cases) {
      const view = render(
        <RoomContent roomName="room" nickName="Hannah" roomType="audio" />,
      )
      expect(screen.queryByText("Mark complete")).toBeNull()
      expect(screen.queryByText("Mark failed")).toBeNull()
      view.unmount()
    }
  })
})
