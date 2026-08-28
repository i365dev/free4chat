import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #165 browser routing cue: the recipient indicator is derived ONLY from
 * structured target metadata (Message.targets resolved against the roster),
 * never from parsing the body, and never duplicates a visible @Name mention.
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

const HERMES_ID = "participant-hermes"
const CODEX_ID = "participant-codex"

function agentText(text: string, targets?: string[]): Message {
  return {
    peerId: "agent-pi",
    name: "Pi-Agent",
    kind: "agent",
    type: "text",
    sequence: 1,
    text,
    targets,
  }
}

function hookReturn(messages: Message[]) {
  return {
    participants: [
      {
        peerId: "human-h",
        name: "Hannah",
        kind: "human" as const,
        room: "test-room",
      },
      {
        peerId: "agent-pi",
        name: "Pi-Agent",
        kind: "agent" as const,
        room: "test-room",
      },
      {
        peerId: HERMES_ID,
        name: "Hermes Agent",
        kind: "agent" as const,
        room: "test-room",
      },
      {
        peerId: CODEX_ID,
        name: "Codex",
        kind: "agent" as const,
        room: "test-room",
      },
    ],
    messages,
    getLocalRoomAuth: () => ({
      roomId: "test-room",
      participantId: "human-h",
      token: "tok",
    }),
    sendCollabResult: vi.fn(),
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

describe("structured recipient routing cue (#165)", () => {
  afterEach(cleanup)

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  function renderWith(messages: Message[]) {
    mockUseSfuChatRoom.mockReturnValue(hookReturn(messages))
    render(<RoomContent roomName="room" nickName="Hannah" roomType="audio" />)
  }

  it("structured target without a literal @Name shows the recipient chip", () => {
    renderWith([agentText("继续这个故事，下一句你来。", [HERMES_ID])])
    expect(screen.getByText("@Hermes Agent")).toBeTruthy()
    expect(screen.getByText("继续这个故事，下一句你来。")).toBeTruthy()
  })

  it("body that already visibly mentions the target is not duplicated", () => {
    renderWith([agentText("@Hermes Agent 接上", [HERMES_ID])])
    // The mention lives only inside the body prose; no exact "@Hermes Agent"
    // recipient chip is rendered next to it.
    expect(screen.getByText("@Hermes Agent 接上")).toBeTruthy()
    expect(screen.queryByText("@Hermes Agent", { exact: true })).toBeNull()
  })

  it("plain messages without targets show no routing cue", () => {
    renderWith([agentText("ordinary room reply")])
    expect(screen.getByText("ordinary room reply")).toBeTruthy()
    expect(screen.queryByText("→")).toBeNull()
  })

  it("multiple structured targets resolve independently", () => {
    renderWith([agentText("both of you continue", [HERMES_ID, CODEX_ID])])
    expect(screen.getByText("@Hermes Agent")).toBeTruthy()
    expect(screen.getByText("@Codex")).toBeTruthy()
  })

  it("unresolvable targets degrade to a count cue without executing content", () => {
    renderWith([agentText("gone", ["participant-vanished"])])
    expect(screen.getByText("participant")).toBeTruthy()
  })
})
