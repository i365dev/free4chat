import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// Observe the long-lived analytics calls (AgentInviteCopied,
// LiveTranscriptStarted/Stopped) without changing any other utility behavior.
vi.mock("@common/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/utils")>()
  return { ...actual, trackAnalyticsEvent: vi.fn() }
})

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

import { trackAnalyticsEvent } from "@common/utils"

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

  it("copies the ordinary Agent invite only through the popover action, without a provider claim", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(trackAnalyticsEvent).mockClear()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    // Opening the popover copies NOTHING and emits NOTHING.
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    expect(screen.getByText("Invite an Agent")).toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
    )

    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Join my temporary")
    )
    expect(writeText).not.toHaveBeenCalledWith(
      expect.stringContaining("--provider-claim")
    )
    await waitFor(() =>
      expect(trackAnalyticsEvent).toHaveBeenCalledWith("AgentInviteCopied", {
        surface: "room",
        roomType: "audio",
      })
    )
    // Feedback stays inside the popover; the header button never becomes
    // "Copied!".
    expect(
      await screen.findByText(/✓ Invite prompt copied\./)
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull()
    expect(screen.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
  })

  it("shows a retryable clipboard error inside the invite popover", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"))
    Object.assign(navigator, { clipboard: { writeText } })
    vi.mocked(trackAnalyticsEvent).mockClear()
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy invite prompt" }))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clipboard access was blocked. Try again."
    )
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "AgentInviteCopied",
      expect.anything()
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
    expect(
      screen.getAllByRole("button", { name: "Leave" }).length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText("Live Transcript").length).toBeGreaterThan(0)
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("Connection command copied")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()
  })

  it("uses the intentional two-row mobile header layout with a truncating Room id", () => {
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

    // Row 1: Room identity (truncating, min-width-safe container) plus the
    // Leave lifecycle action on the same row.
    const identity = within(screen.getByTestId("room-header-identity"))
    expect(identity.getByText("#test-room")).toBeTruthy()
    expect(identity.getByRole("button", { name: "Leave" })).toBeTruthy()

    // Row 2: exactly the three feature actions. No plumbing labels.
    const features = within(screen.getByTestId("room-header-features"))
    expect(features.getByRole("button", { name: "Copy link" })).toBeTruthy()
    expect(features.getByRole("button", { name: "Invite Agent" })).toBeTruthy()
    expect(
      features.getByRole("button", { name: "Live Transcript" })
    ).toBeTruthy()
    expect(
      screen.queryByText("No transcription Runtime connected")
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Connect local Runtime")).not.toBeInTheDocument()
  })

  it("opens the Invite Agent popover from the Live Transcript setup copy", () => {
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

    // Unavailable Live Transcript setup copy points new Humans at the
    // Agent-first path. Cross-opening is one-feature-at-a-time: the Live
    // Transcript dialog closes FIRST, then the Invite Agent dialog opens.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    expect(
      screen.getByRole("dialog", { name: "Live Transcript" })
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Start with Invite Agent" })
    )
    expect(
      screen.queryByRole("dialog", { name: "Live Transcript" })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("dialog", { name: "Invite an Agent" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Copy invite prompt" })
    ).toBeTruthy()
  })

  it("emits LiveTranscriptStarted only on actual Start, never on popover open", () => {
    vi.mocked(trackAnalyticsEvent).mockClear()
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

    // Opening the popover and viewing readiness emits nothing.
    fireEvent.click(screen.getByRole("button", { name: "Live Transcript" }))
    expect(trackAnalyticsEvent).not.toHaveBeenCalledWith(
      "LiveTranscriptStarted",
      expect.anything()
    )

    // Actual Start emits exactly the existing event.
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(trackAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(trackAnalyticsEvent).toHaveBeenCalledWith("LiveTranscriptStarted", {
      roomType: "audio",
    })
  })

  it("switches the active preview between two remote screen shares", async () => {
    const streamA = {} as MediaStream
    const streamB = {} as MediaStream
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      resolvedRoomType: "screenshare",
      participants: [
        {
          peerId: "local-peer-id",
          name: "Alice",
          kind: "human",
          room: "test-room",
          muteState: false,
          screenShareEnabled: false,
          screenShareStream: null,
        },
        {
          peerId: "publisher-a",
          name: "Bob",
          kind: "human",
          room: "test-room",
          screenShareEnabled: true,
          screenShareStream: streamA,
        },
        {
          peerId: "publisher-b",
          name: "Carol",
          kind: "human",
          room: "test-room",
          screenShareEnabled: true,
          screenShareStream: streamB,
        },
      ],
    })

    render(
      <RoomContent
        roomName="test-room"
        nickName="Alice"
        roomType="screenshare"
      />
    )

    const preview = () => document.querySelector("video") as HTMLVideoElement
    await waitFor(() => expect(preview().srcObject).toBe(streamA))
    fireEvent.click(screen.getByText("Carol"))
    await waitFor(() => expect(preview().srcObject).toBe(streamB))
  })
})
