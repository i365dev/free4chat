import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

import RoomContent from "./RoomContent"

interface RenderOptions {
  callback: (token: string) => void
  "error-callback": () => boolean | void
}

function installMockTurnstile() {
  let widgetCounter = 0
  let lastOptions: RenderOptions | null = null
  const render = vi.fn(
    (_container: string | HTMLElement, options: Record<string, unknown>) => {
      lastOptions = options as unknown as RenderOptions
      widgetCounter += 1
      return `widget-${widgetCounter}`
    }
  )
  const execute = vi.fn()
  const reset = vi.fn()
  const remove = vi.fn()

  window.turnstile = { render, execute, reset, remove }

  return {
    render,
    execute,
    reset,
    remove,
    fireSuccess: (token: string) => lastOptions?.callback(token),
  }
}

const baseHookReturn = {
  participants: [] as unknown[],
  messages: [] as unknown[],
  sendTextMessage: vi.fn(),
  sendFileMessage: vi.fn(),
  sendActionMessage: vi.fn(),
  getLocalRoomAuth: vi.fn(() => null),
  sendCollabResponse: vi.fn(() => true),
  localParticipantId: "human-local",
  muteSelf: vi.fn(),
  toggleScreenShare: vi.fn(),
  retryVerification: vi.fn(),
  error: "",
  expiryWarning: "",
  connectionStatus: "verifying" as string,
  resolvedRoomType: "audio" as const,
  timeLeft: 0,
  liveTranscript: { active: false } as { active: boolean },
  liveTranscriptSegments: [],
  runtimeHosts: {},
  runtimeHostProviders: {},
  liveTranscriptMediaAvailable: false,
  startLiveTranscript: vi.fn(),
  stopLiveTranscript: vi.fn(),
  connectLocalRuntime: vi.fn(),
  runtimeConnectionStatus: "idle" as const,
  leaveRoom: vi.fn(),
}

describe("RoomContent — Turnstile widget lifecycle", () => {
  let mock: ReturnType<typeof installMockTurnstile>

  beforeEach(() => {
    mock = installMockTurnstile()
    mockUseSfuChatRoom.mockReset()
    // jsdom doesn't implement scrollIntoView; TextChatCard calls it on
    // every message-list update.
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    delete (window as { turnstile?: unknown }).turnstile
    vi.restoreAllMocks()
  })

  it("removes the widget as soon as verification succeeds, and the connected room UI carries no Turnstile residue", async () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "verifying",
      participants: [],
    })

    const { rerender, container, queryByText } = render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    // The pre-connect screen mounts the bounded Turnstile container.
    expect(queryByText(/verifying/i)).toBeInTheDocument()

    // Grab the real requestToken the component wired up to useSfuChatRoom,
    // and drive it the same way useSfuChatRoom would on a fresh join.
    const options = mockUseSfuChatRoom.mock.calls[0]?.[3] as {
      getTurnstileToken: () => Promise<string>
    }
    expect(options.getTurnstileToken).toBeInstanceOf(Function)

    let tokenPromise: Promise<string> | undefined
    act(() => {
      tokenPromise = options.getTurnstileToken()
    })
    await waitFor(() => expect(mock.execute).toHaveBeenCalledTimes(1))
    expect(mock.remove).not.toHaveBeenCalled()

    act(() => {
      mock.fireSuccess("token-1")
    })
    await expect(tokenPromise).resolves.toBe("token-1")

    // The widget must be torn down the moment the token settles — before the
    // component even transitions to the connected room UI.
    await waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(1))

    // Now simulate useSfuChatRoom moving on to the connected room.
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      participants: [
        {
          peerId: "local-peer",
          name: "tester",
          kind: "human",
          room: "test-room",
          muteState: false,
          audioStream: null,
          screenShareStream: null,
          screenShareEnabled: false,
        },
      ],
    })
    rerender(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )

    expect(queryByText(/verifying/i)).not.toBeInTheDocument()
    expect(queryByText(/joining/i)).not.toBeInTheDocument()
    // No second widget was ever rendered for the connected room, and nothing
    // further was removed — the one widget's lifecycle is fully accounted
    // for by the single success -> remove pair above.
    expect(mock.render).toHaveBeenCalledTimes(1)
    expect(mock.remove).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[id^="cf-chl-widget"]')).toBeNull()
  })

  it("copies an ordinary Agent invite without creating a Runtime provider claim", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Join my temporary")
    )
    expect(writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("--provider-claim")
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied!" })).toBeEnabled()
    )
  })

  it("shows a retryable clipboard error for an ordinary invite", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"))
    Object.assign(navigator, { clipboard: { writeText } })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clipboard access was blocked"
    )
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeEnabled()
  })

  it("uses the Room-wide Live Transcript control without replacing Agent Voice", () => {
    const startLiveTranscript = vi.fn()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: true,
      agentVoiceMediaAvailable: true,
      runtimeHosts: {
        "host-a": {
          runtimeHostId: "host-a",
          speech: { stt: true, tts: true },
        },
      },
      runtimeHostProviders: {
        "host-a": { humanParticipantId: "human-local", claimedAt: 1 },
      },
      startLiveTranscript,
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
        {
          peerId: "agent-codex",
          name: "Codex",
          kind: "agent",
          room: "test-room",
          voiceAvailable: true,
          voiceEnabled: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // #236: one feature-first header control; Start lives inside its popover.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(startLiveTranscript).toHaveBeenCalledWith("host-a")
    expect(screen.queryByText(/Meeting Notes/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Note-taker/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Enable voice for Codex" })
    ).toBeEnabled()
  })

  it("keeps the Room header to user goals — no Runtime plumbing labels (#236)", () => {
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      liveTranscriptMediaAvailable: false,
      agentVoiceMediaAvailable: false,
      runtimeHosts: {},
      runtimeHostProviders: {},
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
        },
      ],
    })

    render(
      <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
    )

    // The toolbar exposes exactly the primary controls, and Live Transcript
    // appears once as a feature button — never as a status strip.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy()
    expect(screen.getAllByText("Live Transcript").length).toBeGreaterThan(0)
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Connection command copied")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()
  })
})
