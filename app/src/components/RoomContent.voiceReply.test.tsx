import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
/**
 * #170 production wiring proof: Voice Reply must be bound only to an
 * explicitly selected current Agent — never silently to roomAgents[0] — the
 * active speaker label is derived from the server-held grant, and a departed
 * speaker's grant clear returns the UI to inactive without auto-migration.
 * Meeting Notes semantics stay untouched.
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

const AGENT_PI = "participant-pi"
const AGENT_HERMES = "participant-hermes"
const AGENT_CODEX = "participant-codex"

function agentParticipants(order: Array<[string, string]>) {
  return [
    {
      peerId: "human-h",
      name: "Hannah",
      kind: "human" as const,
      room: "test-room",
    },
    ...order.map(([peerId, name]) => ({
      peerId,
      name,
      kind: "agent" as const,
      room: "test-room",
    })),
  ]
}

beforeEach(() => {
  // jsdom lacks scrollIntoView; TextChatCard auto-scrolls on new messages.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(cleanup)

function renderRoom({
  participants,
  voiceReply = { active: false },
  meetingNotes = { active: false },
}: {
  participants: ReturnType<typeof agentParticipants>
  voiceReply?: { active: boolean; agentParticipantId?: string }
  meetingNotes?: { active: boolean; agentParticipantId?: string }
}) {
  const startVoiceReply = vi.fn()
  const stopVoiceReply = vi.fn()
  const startMeetingNotes = vi.fn()
  const stopMeetingNotes = vi.fn()
  mockUseSfuChatRoom.mockReturnValue({
    participants,
    messages: [],
    sendTextMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    sendCollabRequest: vi.fn(() => ""),
    sendCollabResponse: vi.fn(),
    sendCollabResult: vi.fn(),
    updateHumanCapabilities: vi.fn(),
    getLocalRoomAuth: vi.fn(() => ({
      roomId: "test-room",
      participantId: "human-h",
      token: "tok",
    })),
    readRoomAttachment: vi.fn(),
    muteSelf: vi.fn(),
    toggleScreenShare: vi.fn(),
    retryVerification: vi.fn(),
    error: "",
    connectionStatus: "connected",
    resolvedRoomType: "audio",
    meetingNotes,
    meetingNotesMediaAvailable: true,
    startMeetingNotes,
    stopMeetingNotes,
    voiceReply,
    voiceReplyMediaAvailable: true,
    startVoiceReply,
    stopVoiceReply,
    localParticipantId: "human-h",
  })
  render(
    <RoomContent roomName="test-room" nickName="Hannah" roomType="audio" />
  )
  return {
    startVoiceReply,
    stopVoiceReply,
    startMeetingNotes,
    stopMeetingNotes,
  }
}

// #170: agent names also render on roster UserCards, so picker assertions
// must be scoped to the dropdown (located via its "Speaker" header).
function voicePicker(): HTMLElement {
  const header = screen.getByText("Speaker")
  const dropdown = header.parentElement
  if (!dropdown) throw new Error("voice reply picker dropdown not rendered")
  return dropdown as HTMLElement
}

describe("Voice Reply explicit speaker selection (#170)", () => {
  it("never starts voice replies silently: the picker lists every Agent", () => {
    const { startVoiceReply } = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
        [AGENT_CODEX, "Codex"],
      ]),
    })

    fireEvent.click(screen.getByText("🔊 Voice replies"))
    // Opening the picker starts nothing by itself.
    expect(startVoiceReply).not.toHaveBeenCalled()
    // Every roster Agent appears in the picker, in roster order.
    const picker = voicePicker()
    expect(within(picker).getByText("Pi-Agent")).toBeTruthy()
    expect(within(picker).getByText("Hermes")).toBeTruthy()
    expect(within(picker).getByText("Codex")).toBeTruthy()
    // Dismissing without choosing still starts nothing.
    fireEvent.click(screen.getByText("🔊 Voice replies"))
    expect(startVoiceReply).not.toHaveBeenCalled()
  })

  it("selecting a non-first Agent binds exactly that participantId", () => {
    const { startVoiceReply } = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
        [AGENT_CODEX, "Codex"],
      ]),
    })

    fireEvent.click(screen.getByText("🔊 Voice replies"))
    fireEvent.click(within(voicePicker()).getByText("Hermes"))
    expect(startVoiceReply).toHaveBeenCalledTimes(1)
    expect(startVoiceReply).toHaveBeenCalledWith(AGENT_HERMES)
    // The picker closes after an explicit selection.
    expect(screen.queryByText("Speaker")).toBeNull()
  })

  it("selection follows the clicked entry, not roster order", () => {
    // Same three Agents, deliberately rotated roster order.
    const first = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
        [AGENT_CODEX, "Codex"],
      ]),
    })
    fireEvent.click(screen.getByText("🔊 Voice replies"))
    fireEvent.click(within(voicePicker()).getByText("Codex"))
    expect(first.startVoiceReply).toHaveBeenCalledWith(AGENT_CODEX)

    cleanup()

    const second = renderRoom({
      participants: agentParticipants([
        [AGENT_CODEX, "Codex"],
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
      ]),
    })
    fireEvent.click(screen.getByText("🔊 Voice replies"))
    fireEvent.click(within(voicePicker()).getByText("Codex"))
    expect(second.startVoiceReply).toHaveBeenCalledWith(AGENT_CODEX)
  })

  it("active grant shows the selected speaker, not a generic stop label", () => {
    const { stopVoiceReply } = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
      ]),
      voiceReply: { active: true, agentParticipantId: AGENT_HERMES },
    })

    expect(screen.getByText(/Voice: Hermes/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Voice: Hermes/))
    expect(stopVoiceReply).toHaveBeenCalledTimes(1)
    // The stop path is still wired to the hook.
    expect(screen.queryByText("🔊 Voice replies")).toBeNull()
  })

  it("a departed speaker or server-cleared grant returns the UI to inactive", () => {
    // Speaker left the roster while the grant still names it: no crash, no
    // migration — the label degrades honestly.
    renderRoom({
      participants: agentParticipants([[AGENT_PI, "Pi-Agent"]]),
      voiceReply: { active: true, agentParticipantId: AGENT_HERMES },
    })
    expect(screen.getByText(/Voice: an Agent/)).toBeTruthy()

    cleanup()

    // Server cleared the grant after departure: the UI offers a fresh,
    // explicit selection again — never an automatic rebind.
    const { startVoiceReply } = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
      ]),
      voiceReply: { active: false },
    })
    expect(screen.getByText("🔊 Voice replies")).toBeTruthy()
    expect(screen.queryByText(/Voice:/)).toBeNull()
    fireEvent.click(screen.getByText("🔊 Voice replies"))
    fireEvent.click(within(voicePicker()).getByText("Hermes"))
    expect(startVoiceReply).toHaveBeenCalledWith(AGENT_HERMES)
  })

  it("Meeting Notes keeps its own explicit note-taker picker unchanged", () => {
    const { stopMeetingNotes } = renderRoom({
      participants: agentParticipants([
        [AGENT_PI, "Pi-Agent"],
        [AGENT_HERMES, "Hermes"],
      ]),
      meetingNotes: { active: true, agentParticipantId: AGENT_PI },
    })

    expect(
      screen.getByText(/Meeting Notes — Listening… \(Pi-Agent\)/)
    ).toBeTruthy()
    fireEvent.click(screen.getByText("📝 Stop"))
    expect(stopMeetingNotes).toHaveBeenCalledTimes(1)
  })
})
