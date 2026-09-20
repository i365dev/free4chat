import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// Observe the long-lived analytics calls without allowing the browser analytics
// fallback timer to outlive jsdom teardown.
vi.mock("@common/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@common/utils")>()
  return { ...actual, trackAnalyticsEvent: vi.fn(), umamiEvent: vi.fn() }
})

const mockUseSfuChatRoom = vi.fn()
vi.mock("../hooks/useSfuChatRoom", () => ({
  useSfuChatRoom: (...args: unknown[]) => mockUseSfuChatRoom(...args),
}))

// Every case here renders the already-connected Room, so the verification
// widget never mounts. Stub the hook instead of loading Cloudflare's script.
vi.mock("../hooks/useTurnstile", () => ({
  useTurnstile: () => ({
    containerRef: { current: null },
    requestToken: vi.fn(),
  }),
}))

import type { Message } from "@common/types"

import RoomContent from "./RoomContent"
import {
  EMPTY_ROOM_APP_CATALOG,
  setProductionRoomAppCatalog,
} from "../common/roomApp"

const PHONE_WIDTH = 390
const DESKTOP_WIDTH = 1024
const MD_BREAKPOINT = 768

/**
 * A minimal valid catalog: the narrow-screen composition only needs the Stage
 * switcher and the App launcher to exist, and one curated App is enough.
 */
const TEST_ROOM_APP_CATALOG = ["test-app-1", "test-app-2"].map((id) => ({
  id,
  label: `Test App ${id.slice(-1)}`,
  url: `https://room-apps.free4.chat/${id}`,
  origin: "https://room-apps.free4.chat",
}))

const baseHookReturn = {
  participants: [] as unknown[],
  messages: [] as unknown[],
  sendTextMessage: vi.fn(),
  sendFileMessage: vi.fn(),
  sendActionMessage: vi.fn(),
  getLocalRoomAuth: vi.fn(() => null),
  sendCollabResponse: vi.fn(() => true),
  localParticipantId: "human-local",
  localMicState: "not_enabled" as const,
  toggleMicrophone: vi.fn(),
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
  roomAppsEnabled: false,
  sendRoomAppMessage: vi.fn(() => false),
  subscribeRoomAppMessages: vi.fn(() => () => undefined),
  sendRoomAppUnicast: vi.fn(() => "delivery_unavailable"),
  subscribeRoomAppUnicast: vi.fn(() => () => undefined),
  subscribeRoomAppUnicastResults: vi.fn(() => () => undefined),
}

// `LOCAL_PEER_ID` is the Room's preserved local sentinel; the local card is the
// only participant the Room App host projection can resolve a self for.
const localParticipant = {
  peerId: "local-peer",
  name: "Alice",
  kind: "human" as const,
  room: "test-room",
  muteState: false,
}
const bobParticipant = {
  peerId: "peer-bob",
  name: "Bob",
  kind: "human" as const,
  room: "test-room",
  muteState: false,
}
const piParticipant = {
  peerId: "agent-pi",
  name: "Pi",
  kind: "agent" as const,
  room: "test-room",
  muteState: false,
}
const codexParticipant = {
  peerId: "agent-codex",
  name: "Codex",
  kind: "agent" as const,
  room: "test-room",
  muteState: false,
}

const taskRequest: Message = {
  peerId: "human-local",
  name: "Alice",
  kind: "human",
  type: "action",
  actionType: "collab",
  sequence: 1,
  collab: {
    requestId: "task-live",
    kind: "request",
    fromParticipantId: "human-local",
    targetParticipantId: "agent-codex",
    summary: "Review this task",
  },
}

/** Class tokens, so `overflow-hidden` can never be mistaken for `hidden`. */
function classes(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean)
}

function renderRoom(overrides: Record<string, unknown> = {}) {
  mockUseSfuChatRoom.mockReturnValue({
    ...baseHookReturn,
    connectionStatus: "connected",
    participants: [localParticipant, bobParticipant, piParticipant],
    ...overrides,
  })
  return render(
    <RoomContent roomName="test-room" nickName="Alice" roomType="audio" />
  )
}

function chatPanel(): Element {
  return screen.getByTestId("interaction-chat").closest(".room-chat-panel")!
}

function resizeHandle(container: HTMLElement): Element {
  return container.querySelector(".cursor-col-resize")!
}

describe("RoomContent — narrow-screen composition", () => {
  let originalWidth: number

  beforeEach(() => {
    originalWidth = window.innerWidth
    vi.stubEnv("NODE_ENV", "test")
    mockUseSfuChatRoom.mockReset()
    setProductionRoomAppCatalog(TEST_ROOM_APP_CATALOG)
    // jsdom doesn't implement scrollIntoView; TextChatCard calls it on every
    // message-list update.
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    window.innerWidth = originalWidth
    // Recents are remembered per browser tab, so one case's opened Apps must
    // never leak into the next case's inline Stage strip.
    window.sessionStorage.clear()
    setProductionRoomAppCatalog(EMPTY_ROOM_APP_CATALOG)
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("opens people and the Stage first on a phone, with Room chat as an explicit choice", () => {
    // Narrow BEFORE mount so the responsive path is the one under test.
    window.innerWidth = PHONE_WIDTH
    renderRoom({
      participants: [localParticipant, codexParticipant],
      messages: [taskRequest],
    })

    const sheet = screen.getByTestId("room-mobile-sheet")
    expect(screen.getByTestId("room-mobile-overflow")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(within(sheet).getByText("People in this Room")).toBeInTheDocument()
    expect(within(sheet).getByTestId("room-stage")).toBeInTheDocument()

    // The interaction remains mounted, but it no longer wins the initial phone
    // viewport over presence and the Stage.
    expect(screen.getByTestId("interaction-content")).toBeInTheDocument()
    expect(screen.getByTestId("interaction-tablist")).toBeInTheDocument()

    // The participant/Stage panel remains one mounted element and is visible.
    const stage = screen.getByTestId("room-stage")
    expect(classes(stage)).toContain("flex")
    expect(classes(stage)).not.toContain("hidden")
    expect(stage).toHaveClass("room-panel", "room-participants-panel")
    expect(stage).toContainElement(
      screen.getByTestId("room-stage-participants")
    )

    fireEvent.click(screen.getByTestId("room-mobile-sheet-close"))
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    expect(classes(screen.getByTestId("room-stage"))).toContain("hidden")

    fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    expect(
      screen.getByTestId("interaction-tab-task-task-live")
    ).toHaveAttribute("aria-selected", "true")
  })

  it("summarises the connected count and the active Agent's coarse state on one line", () => {
    window.innerWidth = PHONE_WIDTH

    // Room scope: the Room-scope AgentActivity supplies the coarse verb.
    const roomScope = renderRoom({
      agentActivities: [
        {
          agentParticipantId: "agent-pi",
          scopeId: "room",
          state: "using_tools",
          turnSequence: 11,
        },
      ],
    })
    const signal = screen.getByTestId("room-mobile-signal")
    expect(signal.tagName).toBe("P")
    expect(signal.className).toContain("truncate")
    expect(signal.className).toContain("md:hidden")
    expect(signal.textContent).toBe("3 participants · Pi · Using tools…")
    roomScope.unmount()

    // Nothing is invented when no Agent reports any state at all.
    const idle = renderRoom({
      participants: [localParticipant, bobParticipant],
    })
    expect(screen.getByTestId("room-mobile-signal").textContent).toBe(
      "2 participants"
    )
    idle.unmount()

    // Active Task with no surviving AgentActivity: the AUTHORITATIVE execution
    // label (#421 Fix C) is the state, and the Task's canonical Agent is named.
    const task = renderRoom({
      participants: [localParticipant, codexParticipant],
      messages: [taskRequest],
      agentActivities: [],
      taskExecutions: [
        {
          taskRequestId: "task-live",
          agentParticipantId: "agent-codex",
          phase: "running",
          currentTurnSequence: 7,
          queuedCount: 0,
        },
      ],
    })
    fireEvent.click(screen.getByTestId("interaction-tab-task-task-live"))
    expect(screen.getByTestId("room-mobile-signal").textContent).toBe(
      "2 participants · Codex · Running"
    )
    task.unmount()
  })

  it("keeps one mounted participant/Stage panel in the people-first sheet", () => {
    window.innerWidth = PHONE_WIDTH
    // Room Apps on, so the Stage switcher and its launcher are part of the
    // panel whose single mount the sheet must reuse.
    renderRoom({ roomAppsEnabled: true })

    // Every header control exists exactly once below `md` today; the sheet must
    // not add a second copy of any of them.
    expect(screen.getAllByRole("button", { name: "Copy link" })).toHaveLength(1)
    expect(screen.getAllByTestId("room-mic-control")).toHaveLength(1)
    const leaveBefore = screen.getAllByRole("button", { name: "Leave" }).length
    // Both Leave controls are pre-existing responsive copies (the phone header
    // row and the `lg`-only toolbar one) — not something this composition adds.
    expect(leaveBefore).toBe(2)
    // The default sheet is a pure layout around the existing panel. Its exact
    // nodes are retained, so participant media, Room App iframes and
    // MessagePorts are never remounted.
    const stageBefore = screen.getByTestId("room-stage")
    const gridBefore = screen.getByTestId("room-stage-participants")
    const launcherBefore = screen.getByTestId("stage-apps-launcher")

    const sheet = screen.getByTestId("room-mobile-sheet")
    expect(sheet).toBeInTheDocument()
    // The Stage panel moved INTO the sheet; it is the same single mount.
    expect(sheet).toContainElement(screen.getByTestId("room-stage"))
    expect(screen.getByTestId("room-stage")).toBe(stageBefore)
    // Participant cards are reachable inside it, and they are the SAME nodes.
    const grid = within(sheet).getByTestId("room-stage-participants")
    expect(grid).toBe(gridBefore)
    expect(within(grid).getByText(/Alice/)).toBeInTheDocument()
    expect(within(grid).getByText(/Bob/)).toBeInTheDocument()
    expect(within(grid).getByText(/Pi/)).toBeInTheDocument()
    // The App launcher lives in the same panel, also exactly once and unmoved.
    expect(within(sheet).getAllByTestId("stage-apps-launcher")).toHaveLength(1)
    expect(within(sheet).getByTestId("stage-apps-launcher")).toBe(
      launcherBefore
    )

    // Nothing was duplicated to make the sheet work.
    expect(screen.getAllByRole("button", { name: "Copy link" })).toHaveLength(1)
    expect(screen.getAllByTestId("room-mic-control")).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Leave" })).toHaveLength(
      leaveBefore
    )

    // Having the sheet open means the panel is shown, never both classes.
    const stage = screen.getByTestId("room-stage")
    expect(classes(stage)).toContain("flex")
    expect(classes(stage)).not.toContain("hidden")
  })

  it("keeps secondary Room controls with the people-first surface", () => {
    window.innerWidth = PHONE_WIDTH
    renderRoom()

    const toolbar = screen.getByTestId("room-header-toolbar")
    const mobileLeave = screen
      .getAllByRole("button", { name: "Leave" })
      .find((button) => classes(button).includes("room-header-leave"))!

    // The default people-first surface reveals the one existing control row.
    expect(classes(toolbar)).toContain("grid")
    expect(classes(toolbar)).not.toContain("hidden")
    expect(classes(mobileLeave)).toContain("inline-flex")
    expect(classes(mobileLeave)).not.toContain("hidden")
    expect(screen.getAllByRole("button", { name: "Copy link" })).toHaveLength(1)

    // Choosing Room chat hides that secondary chrome while preserving its DOM.
    fireEvent.click(screen.getByTestId("room-mobile-sheet-close"))
    expect(classes(toolbar)).toContain("hidden")
    expect(classes(toolbar)).toContain("md:grid")
    expect(classes(mobileLeave)).toContain("hidden")
  })

  it("closes the sheet with Escape and with its own close control", () => {
    window.innerWidth = PHONE_WIDTH
    renderRoom()

    expect(screen.getByTestId("room-mobile-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("room-mobile-overflow")).toHaveAttribute(
      "aria-expanded",
      "true"
    )

    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    expect(screen.getByTestId("room-mobile-overflow")).toHaveAttribute(
      "aria-expanded",
      "false"
    )

    fireEvent.click(screen.getByTestId("room-mobile-overflow"))
    expect(screen.getByTestId("room-mobile-sheet")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("room-mobile-sheet-close"))
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    // The panel itself is never unmounted by closing the sheet.
    expect(screen.getByTestId("room-stage")).toBeInTheDocument()
  })

  it("closes the sheet when the viewport crosses to md", () => {
    window.innerWidth = PHONE_WIDTH
    renderRoom()
    expect(screen.getByTestId("room-mobile-sheet")).toBeInTheDocument()

    act(() => {
      window.innerWidth = DESKTOP_WIDTH
      window.dispatchEvent(new Event("resize"))
    })

    // Phone-only overlay state never leaks into the desktop split.
    expect(window.innerWidth).toBeGreaterThanOrEqual(MD_BREAKPOINT)
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    expect(screen.queryByTestId("room-mobile-sheet-close")).toBeNull()
    expect(classes(screen.getByTestId("room-stage"))).not.toContain("flex")
  })

  it("leaves the desktop split exactly as it was at md and above", () => {
    window.innerWidth = DESKTOP_WIDTH
    const { container } = renderRoom()

    // The one desktop split structure, unchanged.
    expect(classes(screen.getByTestId("room-stage"))).toEqual(
      expect.arrayContaining([
        "room-panel",
        "room-participants-panel",
        "hidden",
        "md:flex",
        "md:flex-none",
        "md:border-r",
      ])
    )
    expect(screen.getByTestId("room-stage")).toHaveStyle({ width: "50%" })
    expect(classes(resizeHandle(container))).toContain("hidden")
    expect(classes(resizeHandle(container))).toContain("md:block")
    // The chat panel is unchanged. It carries no `md:` utility of its own in
    // the shipped markup — it is the `flex-1` pane of the `md:flex-row` content
    // region — so its EXACT class list (plus the region's `md:flex-row` below)
    // is the strongest available "desktop unchanged" assertion.
    expect(classes(chatPanel())).toEqual([
      "room-panel",
      "room-chat-panel",
      "flex",
      "flex-1",
      "flex-col",
      "overflow-hidden",
    ])
    expect(
      classes(screen.getByTestId("interaction-content").parentElement!)
    ).toContain("room-chat-panel")
    expect(classes(container.querySelector(".room-content")!)).toContain(
      "md:flex-row"
    )
    // The sheet and its phone-only triggers are irrelevant here: they stay in
    // the desktop DOM only because they cannot change it.
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    expect(classes(screen.getByTestId("room-mobile-overflow"))).toContain(
      "md:hidden"
    )
    expect(classes(screen.getByTestId("room-mobile-signal"))).toContain(
      "md:hidden"
    )
  })

  it("keeps a fullscreen Room App owning the phone content region", () => {
    window.innerWidth = PHONE_WIDTH
    renderRoom({ roomAppsEnabled: true })

    fireEvent.click(screen.getByTestId("stage-apps-launcher"))
    fireEvent.click(screen.getByTestId("launcher-app-test-app-1"))
    const host = screen.getByTestId("room-app-host")
    fireEvent.click(within(host).getByRole("button", { name: "Fullscreen" }))

    // Focus mode is a Room layout state, not a phone sheet: it replaces the
    // initial people-first overlay with the same single panel.
    expect(screen.queryByTestId("room-mobile-sheet")).toBeNull()
    const stage = screen.getByTestId("room-stage")
    expect(classes(stage)).toContain("flex")
    expect(classes(stage)).not.toContain("hidden")
    expect(stage).toHaveStyle({ width: "100%" })
    expect(stage).toContainElement(host)
  })
})
