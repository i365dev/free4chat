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
  sendCollabRequest: vi.fn(() => ""),
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
  meetingNotes: { active: false } as { active: boolean },
  meetingNotesMediaAvailable: true,
  startMeetingNotes: vi.fn(),
  stopMeetingNotes: vi.fn(),
  createRuntimeProviderClaim: vi.fn(),
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

  it("waits for the Room claim ACK before preparing an invite, then writes only from a second click", async () => {
    let resolveClaim: (value: { providerClaimSecret: string }) => void
    const claim = new Promise<{ providerClaimSecret: string }>((resolve) => {
      resolveClaim = resolve
    })
    const createRuntimeProviderClaim = vi.fn(() => claim)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      createRuntimeProviderClaim,
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    expect(createRuntimeProviderClaim).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Preparing invite..." })
    ).toBeDisabled()

    await act(async () => {
      resolveClaim!({
        providerClaimSecret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      })
      await claim
    })
    expect(screen.getByRole("button", { name: "Copy invite" })).toBeEnabled()
    expect(writeText).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Copy invite" }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("--provider-claim")
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied!" })).toBeEnabled()
    )
  })

  it("keeps a prepared invite available and shows a retryable clipboard error", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"))
    Object.assign(navigator, { clipboard: { writeText } })
    mockUseSfuChatRoom.mockReturnValue({
      ...baseHookReturn,
      connectionStatus: "connected",
      createRuntimeProviderClaim: vi.fn().mockResolvedValue({
        providerClaimSecret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      }),
    })

    render(
      <RoomContent roomName="test-room" nickName="tester" roomType="audio" />
    )
    fireEvent.click(screen.getByRole("button", { name: "Invite Agent" }))
    const copy = await screen.findByRole("button", { name: "Copy invite" })
    fireEvent.click(copy)

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Clipboard access was blocked"
    )
    expect(screen.getByRole("button", { name: "Copy invite" })).toBeEnabled()
  })
})
